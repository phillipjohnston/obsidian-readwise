import {
  App,
  ButtonComponent,
  DataAdapter,
  Modal,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Vault
} from 'obsidian';
import * as zip from "@zip.js/zip.js";
import { Md5 } from "ts-md5";
import { StatusBar } from "./status";

// keep pluginVersion in sync with manifest.json
const pluginVersion = "3.0.1";

// switch to local dev server for development
const baseURL = "https://readwise.io";

interface ReadwiseAuthResponse {
  userAccessToken: string;
}

interface ExportRequestResponse {
  latest_id: number,
  status: string
}

interface ExportStatusResponse {
  totalBooks: number,
  booksExported: number,
  isFinished: boolean,
  taskStatus: string,
  artifactIds: number[],
}

interface ReadwisePluginSettings {
  token: string;

  /** Folder to save highlights */
  readwiseDir: string;

  /** Polling for pending export */
  isSyncing: boolean;

  /** Frequency of automatic sync */
  frequency: string;

  /** Automatically sync on load */
  triggerOnLoad: boolean;

  lastSyncFailed: boolean;
  lastSavedStatusID: number;
  currentSyncStatusID: number;

  /** Should get any deleted books */
  refreshBooks: boolean,

  /** Queue of books to refresh. */
  booksToRefresh: Array<string>;

  /** Queue of books to retry because of previous failure */
  failedBooks: Array<string>;

  /** Map of file path to book ID */
  booksIDsMap: { [filePath: string]: string; };

  /** User choice for confirming delete and reimport */
  reimportShowConfirmation: boolean;
}

// define our initial settings
// quoted keys for easy copying to data.json during development
const DEFAULT_SETTINGS: ReadwisePluginSettings = {
  "token": "",
  "readwiseDir": "Readwise",
  "frequency": "0",
  "triggerOnLoad": true,
  "isSyncing": false,
  "lastSyncFailed": false,
  "lastSavedStatusID": 0,
  "currentSyncStatusID": 0,
  "refreshBooks": false,
  "booksToRefresh": [],
  "failedBooks": [],
  "booksIDsMap": {},
  "reimportShowConfirmation": true
};

/** The name of the Readwise Sync history file, without the extension.
 * This is described as "Sync notification" in the Obsidian export settings
 * on the Readwise website. */
const READWISE_SYNC_FILENAME = "Readwise Syncs" as const;

export default class ReadwisePlugin extends Plugin {
  settings: ReadwisePluginSettings;
  fs: DataAdapter;
  vault: Vault;
  scheduleInterval: null | number = null;
  statusBar: StatusBar;

  getErrorMessageFromResponse(response: Response) {
    if (response && response.status === 409) {
      return "Sync in progress initiated by different client";
    }
    if (response && response.status === 417) {
      return "Obsidian export is locked. Wait for an hour.";
    }
    return `${response ? response.statusText : "Can't connect to server"}`;
  }

  async handleSyncError(buttonContext: ButtonComponent, msg: string) {
    await this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = true;
    await this.saveSettings();
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentElement, msg, "rw-error");
      buttonContext.buttonEl.setText("Run sync");
    } else {
      this.notice(msg, true, 4, true);
    }
  }

  async clearSettingsAfterRun() {
    this.settings.isSyncing = false;
    this.settings.currentSyncStatusID = 0;
    await this.saveSettings();
  }

  async handleSyncSuccess(buttonContext: ButtonComponent, msg: string = "Synced", exportID: number = null) {
    await this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = false;
    if (exportID) {
      this.settings.lastSavedStatusID = exportID;
    }
    await this.saveSettings();
    // if we have a button context, update the text on it
    // this is the case if we fired on a "Run sync" click (the button)
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentNode.parentElement, msg, "rw-success");
      buttonContext.buttonEl.setText("Run sync");
    }
  }

  /** Polls the Readwise API for the status of a given export;
   * uses recursion for polling so that it can be awaited. */
  async getExportStatus(statusID: number, buttonContext?: ButtonComponent, _processedArtifactIds?: Set<number>, _unknownStatusCount?: number, _lastBooksExported?: number) {
    if (statusID <= this.settings.lastSavedStatusID) {
      console.log(`Readwise Official plugin: Already saved data from export ${statusID}`);
      await this.handleSyncSuccess(buttonContext);
      this.notice("Readwise data is already up to date", false, 4);
      return;
    }
    const processedArtifactIds = _processedArtifactIds ?? new Set();
    const unknownStatusCount = _unknownStatusCount ?? 0;
    const lastBooksExported = _lastBooksExported ?? 0;
    const downloadUnprocessedArtifacts = async (allArtifactIds: number[]) => {
      for (const artifactId of allArtifactIds) {
        if (!processedArtifactIds.has(artifactId)) {
          await this.downloadArtifact(artifactId, buttonContext);
          processedArtifactIds.add(artifactId);
        }
      }
    };
    try {
      const response = await fetch(
        // status of archive build from this endpoint
        `${baseURL}/api/get_export_status?exportStatusId=${statusID}`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (response && response.ok) {
        const data: ExportStatusResponse = await response.json();

        const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY'];
        const SUCCESS_STATUSES = ['SUCCESS'];

        // Track if export is making progress
        const currentBooksExported = data.booksExported || 0;
        const isStuck = data.taskStatus === 'UNKNOWN' && currentBooksExported === lastBooksExported && currentBooksExported > 0;
        const newUnknownCount = data.taskStatus === 'UNKNOWN' ? unknownStatusCount + 1 : 0;

        // If UNKNOWN and no progress for 30 seconds, or UNKNOWN persists for 60 seconds total
        if (data.taskStatus === 'UNKNOWN' && (unknownStatusCount >= 60 || (isStuck && unknownStatusCount >= 30))) {
          console.log(`Readwise Official plugin: UNKNOWN status persisted for ${unknownStatusCount} attempts`);
          console.log("Readwise Official plugin: data at timeout:", data);

          // Check if export is actually complete
          const isComplete = data.isFinished || (data.booksExported && data.totalBooks && data.booksExported >= data.totalBooks);

          if (isComplete) {
            console.log("Readwise Official plugin: Export appears complete despite UNKNOWN status");
            // Treat as success
            await downloadUnprocessedArtifacts(data.artifactIds);
            await this.acknowledgeSyncCompleted(buttonContext);
            await this.handleSyncSuccess(buttonContext, "Synced!", statusID);
            this.notice("Readwise sync completed", true, 1, true);
            console.log("Readwise Official plugin: completed sync");
            // @ts-ignore
            if (this.app.isMobile) {
              this.notice("If you don't see all of your Readwise files, please reload the Obsidian app", true,);
            }
            return;
          } else {
            console.log("Readwise Official plugin: Export appears incomplete, treating as error");
            await this.handleSyncError(buttonContext, "Sync timed out with UNKNOWN status");
            return;
          }
        }

        if (WAITING_STATUSES.includes(data.taskStatus) || data.taskStatus === 'UNKNOWN') {
          if (data.taskStatus === 'UNKNOWN') {
            const progressInfo = isStuck ? ` - STUCK at ${currentBooksExported}/${data.totalBooks}` : ` - progressing (${currentBooksExported}/${data.totalBooks})`;
            console.log(`Readwise Official plugin: UNKNOWN status encountered (attempt ${newUnknownCount}/60)${progressInfo}`);
          }
          if (data.booksExported) {
            const progressMsg = `Exporting Readwise data (${data.booksExported} / ${data.totalBooks}) ...`;
            this.notice(progressMsg, false, 35, true);
          } else {
            this.notice("Building export...");
          }
          // process any artifacts available while the export is still being generated
          await downloadUnprocessedArtifacts(data.artifactIds);
          // wait 1 second
          await new Promise(resolve => setTimeout(resolve, 1000));
          // then keep polling
          await this.getExportStatus(statusID, buttonContext, processedArtifactIds, newUnknownCount, currentBooksExported);
        } else if (SUCCESS_STATUSES.includes(data.taskStatus)) {
          // make sure all artifacts are processed
          await downloadUnprocessedArtifacts(data.artifactIds);

          await this.acknowledgeSyncCompleted(buttonContext);
          await this.handleSyncSuccess(buttonContext, "Synced!", statusID);
          this.notice("Readwise sync completed", true, 1, true);
          console.log("Readwise Official plugin: completed sync");
          // @ts-ignore
          if (this.app.isMobile) {
            this.notice("If you don't see all of your Readwise files, please reload the Obsidian app", true,);

          }
        } else {
          console.log("Readwise Official plugin: unexpected status in getExportStatus: ", data);
          await this.handleSyncError(buttonContext, "Sync failed - unexpected status: " + data.taskStatus);
          return;
        }
      } else {
        console.log("Readwise Official plugin: bad response in getExportStatus: ", response);
        await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      }
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in getExportStatus: ", e);
      await this.handleSyncError(buttonContext, "Sync failed");
    }
  }

  /** Requests the archive from Readwise, polling until it's ready */
  async queueExport(buttonContext?: ButtonComponent, statusId?: number, auto?: boolean) {
    if (this.settings.isSyncing) {
      this.notice("Readwise sync already in progress", true);
      return;
    }

    console.log('Readwise Official plugin: requesting archive...');
    this.settings.isSyncing = true;
    await this.saveSettings();

    const parentDeleted = !await this.app.vault.adapter.exists(this.settings.readwiseDir);

    // kickoff archive build form this endpoint
    let url = `${baseURL}/api/obsidian/init?parentPageDeleted=${parentDeleted}`;
    if (statusId) {
      url += `&statusID=${statusId}`;
    }
    if (auto) {
      url += `&auto=${auto}`;
    }
    let response, data: ExportRequestResponse;
    try {
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in queueExport: ", e);
    }

    if (response && response.ok) {
      data = await response.json();

      if (data.latest_id <= this.settings.lastSavedStatusID) {
        await this.handleSyncSuccess(buttonContext);
        this.notice("Readwise data is already up to date", false, 4, true);
        return;
      }

      // save the sync status ID so it can be polled until the archive is ready
      this.settings.currentSyncStatusID = data.latest_id;
      await this.saveSettings();
      console.log("Readwise Official plugin: saved currentSyncStatusID", this.settings.currentSyncStatusID);

      if (response.status === 201) {
        this.notice("Syncing Readwise data");
        await this.getExportStatus(this.settings.currentSyncStatusID, buttonContext);
        console.log('Readwise Official plugin: queueExport done');
      } else {
        await this.handleSyncSuccess(buttonContext, "Synced", data.latest_id);
        this.notice("Latest Readwise sync already happened on your other device. Data should be up to date", false, 4, true);
      }
    } else {
      console.log("Readwise Official plugin: bad response in queueExport: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
  }

  notice(msg: string, show = false, timeout = 0, forcing: boolean = false) {
    if (show) {
      new Notice(msg);
    }
    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar.displayMessage(msg.toLowerCase(), timeout, forcing);
    } else {
      if (!show) {
        new Notice(msg);
      }
    }
  }

  showInfoStatus(container: HTMLElement, msg: string, className = "") {
    let info = container.find('.rw-info-container');
    info.setText(msg);
    info.addClass(className);
  }

  clearInfoStatus(container: HTMLElement) {
    let info = container.find('.rw-info-container');
    info.empty();
  }

  getAuthHeaders() {
    return {
      'AUTHORIZATION': `Token ${this.settings.token}`,
      'Obsidian-Client': `${this.getObsidianClientID()}`,
      'Readwise-Client-Version': pluginVersion,
    };
  }

  async downloadArtifact(artifactId: number, buttonContext: ButtonComponent): Promise<void> {
    // download archive from this endpoint
    let artifactURL = `${baseURL}/api/v2/download_artifact/${artifactId}`;

    let response, blob;
    try {
      response = await fetch(
        artifactURL, { headers: this.getAuthHeaders() }
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in downloadExport: ", e);
    }
    if (response && response.ok) {
      blob = await response.blob();
    } else {
      console.log("Readwise Official plugin: bad response in downloadExport: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      throw new Error(`Readwise: error while fetching artifact ${artifactId}`);
    }

    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();
    if (entries.length) {
      for (const entry of entries) {
        // will be extracted from JSON data
        let bookID: string;
        let data: Record<string, any>;

        /** Combo of file `readwiseDir` and book name.
         * Example: `Readwise/Books/Name of Book.json` */
        const processedFileName = normalizePath(
          entry.filename
            .replace(/^Readwise/, this.settings.readwiseDir)
            .replace(/\.json$/, ".md")
        );
        const isReadwiseSyncFile = processedFileName === `${this.settings.readwiseDir}/${READWISE_SYNC_FILENAME}.md`;

        try {
          const fileContent = await entry.getData(new zip.TextWriter());
          if (isReadwiseSyncFile) {
            data = {
              append_only_content: fileContent,
            };
          } else {
            data = JSON.parse(fileContent);
          }

          bookID = this.encodeReadwiseBookId(data.book_id) || this.encodeReaderDocumentId(data.reader_document_id);

          const undefinedBook = !bookID || !processedFileName;
          if (undefinedBook && !isReadwiseSyncFile) {
            console.error(`Error while processing entry: ${entry.filename}`);
          }

          // write the full document text file
          if (data.full_document_text && data.full_document_text_path) {
            const processedFullDocumentTextFileName = data.full_document_text_path.replace(/^Readwise/, this.settings.readwiseDir);
            console.log("Writing full document text", processedFullDocumentTextFileName);
            // track the book
            this.settings.booksIDsMap[processedFullDocumentTextFileName] = bookID;
            // ensure the directory exists
            await this.createDirForFile(processedFullDocumentTextFileName);
            if (!await this.fs.exists(processedFullDocumentTextFileName)) {
              // it's a new full document content file, just save it
              await this.fs.write(processedFullDocumentTextFileName, data.full_document_text);
            } else {
              // full document content file already exists — overwrite it if it wasn't edited locally
              const existingFullDocument = await this.fs.read(processedFullDocumentTextFileName);
              const existingFullDocumentHash = Md5.hashStr(existingFullDocument).toString();
              if (existingFullDocumentHash === data.last_full_document_hash) {
                await this.fs.write(processedFullDocumentTextFileName, data.full_document_text);
              }
            }
          }

          // write the actual files
          let contentToSave = data.full_content ?? data.append_only_content;
          if (contentToSave) {
            // track the book
            this.settings.booksIDsMap[processedFileName] = bookID;
            // ensure the directory exists
            await this.createDirForFile(processedFileName);
            if (await this.fs.exists(processedFileName)) {
              // if the file already exists we need to append content to existing one
              const existingContent = await this.fs.read(processedFileName);
              const existingContentHash = Md5.hashStr(existingContent).toString();
              if (existingContentHash !== data.last_content_hash) {
                // content has been modified (it differs from the previously exported full document)
                contentToSave = existingContent.trimEnd() + "\n" + data.append_only_content;
              }
            }
            await this.fs.write(processedFileName, contentToSave);
          }

          // save the entry in settings to ensure that it can be
          // retried later when deleted files are re-synced if
          // the user has `settings.refreshBooks` enabled
          if (bookID) await this.saveSettings();
        } catch (e) {
          console.log(`Readwise Official plugin: error writing ${processedFileName}:`, e);
          this.notice(`Readwise: error while writing ${processedFileName}: ${e}`, true, 4, true);
          if (bookID) {
            // handles case where user doesn't have `settings.refreshBooks` enabled
            await this.addToFailedBooks(bookID);
            await this.saveSettings();
          }
          // communicate with readwise?
          throw new Error(`Readwise: error while processing artifact ${artifactId}`);
        }

        if (data) {
          await this.removeBooksFromRefresh([this.encodeReadwiseBookId(data.book_id), this.encodeReaderDocumentId(data.reader_document_id)]);
          await this.removeBookFromFailedBooks([this.encodeReadwiseBookId(data.book_id), this.encodeReaderDocumentId(data.reader_document_id)]);
        }
      }
      await this.saveSettings();
    }
    // close the ZipReader
    await zipReader.close();

    // wait for the metadata cache to process created/updated documents
    await new Promise<void>((resolve) => {
      const timeoutSeconds = 15;
      console.log(`Readwise Official plugin: waiting for metadata cache processing for up to ${timeoutSeconds}s...`)
      const timeout = setTimeout(() => {
        this.app.metadataCache.offref(eventRef);
        console.log("Readwise Official plugin: metadata cache processing timeout reached.");
        resolve();
      }, timeoutSeconds * 1000);

      const eventRef = this.app.metadataCache.on("resolved", () => {
        this.app.metadataCache.offref(eventRef);
        clearTimeout(timeout);
        console.log("Readwise Official plugin: metadata cache processing has finished.");
        resolve();
      });
    });
  }

  async acknowledgeSyncCompleted(buttonContext: ButtonComponent) {
    let response;
    try {
      response = await fetch(
        `${baseURL}/api/obsidian/sync_ack`,
        {
          headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
          method: "POST",
        });
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed to acknowledged sync: ", e);
    }
    if (response && response.ok) {
      return;
    } else {
      console.log("Readwise Official plugin: bad response in acknowledge sync: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
  }

  async configureSchedule() {
    const minutes = parseInt(this.settings.frequency);
    let milliseconds = minutes * 60 * 1000; // minutes * seconds * milliseconds
    console.log('Readwise Official plugin: setting interval to ', milliseconds, 'milliseconds');
    window.clearInterval(this.scheduleInterval);
    this.scheduleInterval = null;
    if (!milliseconds) {
      // user set frequency to manual
      return;
    }
    this.scheduleInterval = window.setInterval(() => this.syncBookHighlights(undefined, true), milliseconds);
    this.registerInterval(this.scheduleInterval);
  }

  /** Syncs provided book IDs, or uses the booksToRefresh list if none provided.
   * ALL syncing starts with this function. */
  async syncBookHighlights(
    /** optional list of specific book IDs to sync */
    bookIds?: Array<string>,

    /** if true, was not initiated by user */
    auto?: boolean,
  ) {
    if (!this.settings.token) return;

    let targetBookIds = [
      // try to sync provided bookIds
      ...(bookIds || []),

      // always try to sync failedBooks
      ...this.settings.failedBooks,
    ];

    // only sync `booksToRefresh` items if "resync deleted files" enabled
    if (this.settings.refreshBooks) {
      targetBookIds = [
        ...targetBookIds,
        ...this.settings.booksToRefresh,
      ];
    }

    if (!targetBookIds.length) {
      console.log('Readwise Official plugin: no targetBookIds, checking for new highlights');
      // no need to hit refresh_book_export;
      // just check if there's new highlights from the server
      await this.queueExport();
      return;
    }

    console.log('Readwise Official plugin: refreshing books', { targetBookIds });

    let requestBookIds: string[] = [];
    let requestReaderDocumentIds: string[] = [];
    targetBookIds.map(id => {
      const readerDocumentId = this.decodeReaderDocumentId(id);
      if (readerDocumentId) {
        requestReaderDocumentIds.push(readerDocumentId);
      } else {
        requestBookIds.push(id);
      }
    });

    try {
      const response = await fetch(
        // add books to next archive build from this endpoint
        // NOTE: should only end up calling this endpoint when:
        // 1. there are failedBooks
        // 2. there are booksToRefresh
        `${baseURL}/api/refresh_book_export`,
        {
          headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
          method: "POST",
          body: JSON.stringify({
            exportTarget: 'obsidian',
            userBookIds: requestBookIds,
            readerDocumentIds: requestReaderDocumentIds,
          })
        }
      );

      if (response && response.ok) {
        await this.queueExport();
        return;
      } else {
        console.log(`Readwise Official plugin: saving book id ${bookIds} to refresh later`);
        const deduplicatedBookIds = new Set([...this.settings.booksToRefresh, ...bookIds]);
        this.settings.booksToRefresh = Array.from(deduplicatedBookIds);
        await this.saveSettings();
        return;
      }
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in syncBookHighlights: ", e);
    }
  }

  async addToFailedBooks(bookId: string) {
    // NOTE: settings.failedBooks was added after initial settings schema,
    // so not all users may have it, hence the fallback to DEFAULT_SETTINGS.failedBooks
    let failedBooks = [...(this.settings.failedBooks || DEFAULT_SETTINGS.failedBooks)];
    failedBooks.push(bookId);
    console.log(`Readwise Official plugin: added book id ${bookId} to failed books`);
    this.settings.failedBooks = failedBooks;

    // don't forget to save after!
    // but don't do that here; this allows batching when removing multiple books.
  }

  async addBookToRefresh(bookId: string) {
    let booksToRefresh = [...this.settings.booksToRefresh];
    booksToRefresh.push(bookId);
    console.log(`Readwise Official plugin: added book id ${bookId} to refresh list`);
    this.settings.booksToRefresh = booksToRefresh;
    await this.saveSettings();
  }

  async removeBooksFromRefresh(bookIds: Array<string> = []) {
    if (!bookIds.length) return;

    console.log(`Readwise Official plugin: removing book ids ${bookIds.join(', ')} from refresh list`);
    this.settings.booksToRefresh = this.settings.booksToRefresh.filter(n => !bookIds.includes(n));

    // don't forget to save after!
    // but don't do that here; this allows batching when removing multiple books.
  }

  async removeBookFromFailedBooks(bookIds: Array<string> = []) {
    if (!bookIds.length) return;

    console.log(`Readwise Official plugin: removing book ids ${bookIds.join(', ')} from failed list`);
    this.settings.failedBooks = this.settings.failedBooks.filter(n => !bookIds.includes(n));

    // don't forget to save after!
    // but don't do that here; this allows batching when removing multiple books.
  }

  async reimportFile(vault: Vault, fileName: string) {
    try {
      this.notice("Deleting and reimporting file...", true);
      await vault.delete(vault.getAbstractFileByPath(fileName));
      const bookId = this.settings.booksIDsMap[fileName];
      await this.addBookToRefresh(bookId);

      // specifically re-sync this one file (not this.settings.booksToRefresh)
      // because the user may have `settings.refreshBooks` disabled
      await this.syncBookHighlights([bookId]);
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in Reimport current file: ", e);
    }
  }

  async createDirForFile(filePath: string) {
    const dirPath = filePath.replace(/\/*$/, '').replace(/^(.+)\/[^\/]*?$/, '$1');
    const exists = await this.fs.exists(dirPath);
    if (!exists) {
      await this.fs.mkdir(dirPath);
    }
  }

  async onload() {
    await this.loadSettings();

    // @ts-expect-error - no type for isMobile
    if (!this.app.isMobile) {
      this.statusBar = new StatusBar(this.addStatusBarItem());
      this.registerInterval(
        window.setInterval(() => this.statusBar.display(), 1000)
      );
    }

    this.app.vault.on("rename", async (file, oldPath) => {
      const bookId = this.settings.booksIDsMap[oldPath];
      if (!bookId) {
        return;
      }
      delete this.settings.booksIDsMap[oldPath];
      this.settings.booksIDsMap[file.path] = bookId;
      await this.saveSettings();
    });
    this.addCommand({
      id: 'readwise-official-sync',
      name: 'Sync your data now',
      callback: () => {
        console.log(`Readwise: Sync triggered. booksToRefresh: ${this.settings.booksToRefresh.length}, failedBooks: ${this.settings.failedBooks.length}`);
        this.syncBookHighlights();
      }
    });
    this.addCommand({
      id: 'readwise-official-force-refresh-queue',
      name: 'Force sync refresh queue',
      callback: async () => {
        const totalToRefresh = this.settings.booksToRefresh.length + this.settings.failedBooks.length;

        if (totalToRefresh === 0) {
          new Notice('No books in refresh queue!', 5000);
          return;
        }

        if (!this.settings.refreshBooks) {
          new Notice('Warning: "Resync deleted files" is disabled. Enable it in settings to sync refresh queue.', 10000);
          console.log(`Readwise: refreshBooks setting is false. booksToRefresh will not be synced.`);
          return;
        }

        console.log(`Readwise: Force refreshing ${totalToRefresh} books`);
        console.log(`Readwise: booksToRefresh: ${this.settings.booksToRefresh.length}`);
        console.log(`Readwise: failedBooks: ${this.settings.failedBooks.length}`);
        console.log(`Readwise: refreshBooks setting: ${this.settings.refreshBooks}`);

        new Notice(`Force syncing ${totalToRefresh} books from refresh queue...`, 10000);

        try {
          // Call syncBookHighlights which should trigger refresh_book_export with forceRefresh
          await this.syncBookHighlights();

          console.log('Readwise: Force refresh completed');
        } catch (e) {
          console.error('Readwise: Error during force refresh:', e);
          new Notice(`Error: ${e.message}`, 10000);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-clear-refresh-queue',
      name: 'Clear refresh queue',
      callback: async () => {
        const totalItems = this.settings.booksToRefresh.length + this.settings.failedBooks.length;

        if (totalItems === 0) {
          new Notice('Refresh queue is already empty!', 5000);
          return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText("Clear refresh queue?");
        modal.contentEl.createEl('p', {
          text: `This will remove ${totalItems} items from the refresh queue (${this.settings.booksToRefresh.length} to refresh, ${this.settings.failedBooks.length} failed). They will NOT be synced unless re-added.`,
          cls: 'rw-modal-warning-text',
        });

        const buttonsContainer = modal.contentEl.createEl('div', { cls: "rw-modal-btns" });
        const cancelBtn = buttonsContainer.createEl("button", { text: "Cancel" });
        const confirmBtn = buttonsContainer.createEl("button", { text: "Clear Queue", cls: 'mod-warning' });

        cancelBtn.onclick = () => modal.close();
        confirmBtn.onclick = async () => {
          console.log(`Readwise: Clearing ${totalItems} items from refresh queue`);
          this.settings.booksToRefresh = [];
          this.settings.failedBooks = [];
          await this.saveSettings();
          new Notice('Refresh queue cleared', 5000);
          modal.close();
        };

        modal.open();
      }
    });
    this.addCommand({
      id: 'readwise-official-format',
      name: 'Customize formatting',
      callback: () => window.open(`${baseURL}/export/obsidian/preferences`)
    });
    this.addCommand({
      id: 'readwise-official-reimport-file',
      name: 'Delete and reimport this document',
      checkCallback: (checking: boolean) => {
        const activeFilePath = this.app.workspace.getActiveFile()?.path;
        const isRWfile = activeFilePath && activeFilePath in this.settings.booksIDsMap;
        if (checking) {
          return isRWfile;
        }
        if (this.settings.reimportShowConfirmation) {
          const modal = new Modal(this.app);
          modal.titleEl.setText("Delete and reimport this document?");
          modal.contentEl.createEl(
            'p',
            {
              text: 'Warning: Proceeding will delete this file entirely (including any changes you made) ' +
                'and then reimport a new copy of your highlights from Readwise.',
              cls: 'rw-modal-warning-text',
            });
          const buttonsContainer = modal.contentEl.createEl('div', { "cls": "rw-modal-btns" });
          const cancelBtn = buttonsContainer.createEl("button", { "text": "Cancel" });
          const confirmBtn = buttonsContainer.createEl("button", { "text": "Proceed", 'cls': 'mod-warning' });
          const showConfContainer = modal.contentEl.createEl('div', { 'cls': 'rw-modal-confirmation' });
          showConfContainer.createEl("label", { "attr": { "for": "rw-ask-nl" }, "text": "Don't ask me in the future" });
          const showConf = showConfContainer.createEl("input", { "type": "checkbox", "attr": { "name": "rw-ask-nl", "id": "rw-ask-nl" } });
          showConf.addEventListener('change', async (ev) => {
            // @ts-expect-error - target.checked is not typed (TODO add type narrowing)
            this.settings.reimportShowConfirmation = !ev.target.checked;
            await this.saveSettings();
          });
          cancelBtn.onClickEvent(() => {
            modal.close();
          });
          confirmBtn.onClickEvent(() => {
            this.reimportFile(this.app.vault, activeFilePath);
            modal.close();
          });
          modal.open();
        } else {
          this.reimportFile(this.app.vault, activeFilePath);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-diagnostics',
      name: 'Show sync diagnostics',
      callback: async () => {
        const categories = ['Articles', 'Books', 'Podcasts', 'Tweets'];
        let diagnosticInfo = '# Readwise Sync Diagnostics\n\n';

        diagnosticInfo += '## Sync Status\n';
        diagnosticInfo += `- Last Saved Status ID: ${this.settings.lastSavedStatusID}\n`;
        diagnosticInfo += `- Current Sync Status ID: ${this.settings.currentSyncStatusID}\n`;
        diagnosticInfo += `- Is Syncing: ${this.settings.isSyncing}\n`;
        diagnosticInfo += `- Last Sync Failed: ${this.settings.lastSyncFailed}\n`;
        diagnosticInfo += `- Refresh Books Enabled: ${this.settings.refreshBooks}\n`;
        diagnosticInfo += `- Books To Refresh: ${this.settings.booksToRefresh.length}\n`;
        diagnosticInfo += `- Failed Books: ${this.settings.failedBooks.length}\n\n`;

        diagnosticInfo += '## Content by Category\n';
        let totalFiles = 0;
        for (const category of categories) {
          const categoryPath = `${this.settings.readwiseDir}/${category}`;
          try {
            const files = await this.app.vault.adapter.list(categoryPath);
            const mdFiles = files.files.filter(f => f.endsWith('.md'));
            diagnosticInfo += `- ${category}: ${mdFiles.length} files\n`;
            totalFiles += mdFiles.length;
          } catch (e) {
            diagnosticInfo += `- ${category}: 0 files (or directory doesn't exist)\n`;
          }
        }
        diagnosticInfo += `\n**Total**: ${totalFiles} files\n\n`;

        diagnosticInfo += '## Tracked Books\n';
        diagnosticInfo += `- Total tracked in booksIDsMap: ${Object.keys(this.settings.booksIDsMap).length}\n\n`;

        diagnosticInfo += '## Failed Books List\n';
        if (this.settings.failedBooks.length > 0) {
          diagnosticInfo += this.settings.failedBooks.map(id => `- ${id}`).join('\n');
        } else {
          diagnosticInfo += 'None\n';
        }

        diagnosticInfo += '\n\n## Books To Refresh List\n';
        if (this.settings.booksToRefresh.length > 0) {
          diagnosticInfo += this.settings.booksToRefresh.slice(0, 20).map(id => `- ${id}`).join('\n');
          if (this.settings.booksToRefresh.length > 20) {
            diagnosticInfo += `\n... and ${this.settings.booksToRefresh.length - 20} more`;
          }
        } else {
          diagnosticInfo += 'None\n';
        }

        console.log(diagnosticInfo);
        new Notice('Diagnostics printed to console', 5000);

        // Also create a temp file with diagnostics
        const tempFile = `${this.settings.readwiseDir}/Readwise-Diagnostics-${Date.now()}.md`;
        await this.app.vault.create(tempFile, diagnosticInfo);
        const file = this.app.vault.getAbstractFileByPath(tempFile);
        if (file) {
          // @ts-ignore
          await this.app.workspace.getLeaf().openFile(file);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-clear-category',
      name: 'Clear and resync a category',
      callback: async () => {
        const categories = ['Articles', 'Books', 'Podcasts', 'Tweets'];
        const modal = new Modal(this.app);
        modal.titleEl.setText("Select category to clear and resync");
        modal.contentEl.createEl('p', {
          text: 'This will delete all files in the selected category and mark them for re-import on next sync.',
          cls: 'rw-modal-warning-text',
        });

        const selectContainer = modal.contentEl.createEl('div', { cls: 'rw-modal-select' });
        const select = selectContainer.createEl('select');
        categories.forEach(cat => {
          select.createEl('option', { text: cat, value: cat });
        });

        const buttonsContainer = modal.contentEl.createEl('div', { cls: "rw-modal-btns" });
        const cancelBtn = buttonsContainer.createEl("button", { text: "Cancel" });
        const confirmBtn = buttonsContainer.createEl("button", { text: "Clear & Resync", cls: 'mod-warning' });

        cancelBtn.onclick = () => modal.close();
        confirmBtn.onclick = async () => {
          const selectedCategory = select.value;
          const categoryPath = `${this.settings.readwiseDir}/${selectedCategory}`;

          try {
            const files = await this.app.vault.adapter.list(categoryPath);
            const mdFiles = files.files.filter(f => f.endsWith('.md'));

            new Notice(`Deleting ${mdFiles.length} files from ${selectedCategory}...`);

            const bookIdsToRefresh: string[] = [];
            for (const filePath of mdFiles) {
              const bookId = this.settings.booksIDsMap[filePath];
              if (bookId) {
                bookIdsToRefresh.push(bookId);
                delete this.settings.booksIDsMap[filePath];
              }
              await this.app.vault.adapter.remove(filePath);
            }

            // Add all book IDs to refresh list
            this.settings.booksToRefresh = [...new Set([...this.settings.booksToRefresh, ...bookIdsToRefresh])];
            await this.saveSettings();

            new Notice(`Cleared ${selectedCategory}. Run sync to re-import.`, 5000);
            console.log(`Readwise: Cleared ${mdFiles.length} files from ${selectedCategory}, marked ${bookIdsToRefresh.length} books for refresh`);
          } catch (e) {
            console.error('Error clearing category:', e);
            new Notice(`Error clearing ${selectedCategory}: ${e.message}`, 5000);
          }
          modal.close();
        };

        modal.open();
      }
    });
    this.addCommand({
      id: 'readwise-official-find-duplicates',
      name: 'Find duplicate filenames',
      callback: async () => {
        const categories = ['Articles', 'Books', 'Podcasts', 'Tweets'];
        let duplicateReport = '# Duplicate Filename Report\n\n';
        let foundDuplicates = false;

        for (const category of categories) {
          const categoryPath = `${this.settings.readwiseDir}/${category}`;
          try {
            const files = await this.app.vault.adapter.list(categoryPath);
            const mdFiles = files.files.filter(f => f.endsWith('.md'));

            const fileNames = mdFiles.map(f => f.split('/').pop());
            const nameCounts: { [name: string]: number } = {};
            fileNames.forEach(name => {
              nameCounts[name] = (nameCounts[name] || 0) + 1;
            });

            const duplicates = Object.entries(nameCounts).filter(([_, count]) => count > 1);
            if (duplicates.length > 0) {
              foundDuplicates = true;
              duplicateReport += `## ${category}\n`;
              duplicates.forEach(([name, count]) => {
                duplicateReport += `- ${name}: ${count} copies\n`;
              });
              duplicateReport += '\n';
            }
          } catch (e) {
            // Category doesn't exist or error reading
          }
        }

        if (!foundDuplicates) {
          duplicateReport += 'No duplicate filenames found.\n';
        }

        console.log(duplicateReport);
        new Notice('Duplicate report printed to console', 5000);

        const tempFile = `${this.settings.readwiseDir}/Readwise-Duplicates-${Date.now()}.md`;
        await this.app.vault.create(tempFile, duplicateReport);
        const file = this.app.vault.getAbstractFileByPath(tempFile);
        if (file) {
          // @ts-ignore
          await this.app.workspace.getLeaf().openFile(file);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-check-collisions',
      name: 'Check for filename collisions',
      callback: async () => {
        let collisionReport = '# Filename Collision Report\n\n';
        collisionReport += 'This report shows potential book ID collisions where multiple book IDs may map to the same filename.\n\n';

        // Invert the booksIDsMap to find collisions
        const idToPathMap: { [id: string]: string[] } = {};
        Object.entries(this.settings.booksIDsMap).forEach(([path, id]) => {
          if (!idToPathMap[id]) {
            idToPathMap[id] = [];
          }
          idToPathMap[id].push(path);
        });

        // Find IDs that map to multiple paths (shouldn't happen)
        const multiPathIds = Object.entries(idToPathMap).filter(([_, paths]) => paths.length > 1);

        if (multiPathIds.length > 0) {
          collisionReport += '## Multiple Paths for Same Book ID\n';
          collisionReport += '(This indicates an internal tracking issue)\n\n';
          multiPathIds.forEach(([id, paths]) => {
            collisionReport += `### Book ID: ${id}\n`;
            paths.forEach(p => collisionReport += `- ${p}\n`);
            collisionReport += '\n';
          });
        } else {
          collisionReport += '## Multiple Paths for Same Book ID\n';
          collisionReport += 'None found (good!).\n\n';
        }

        // Check for files that exist but aren't tracked
        collisionReport += '## Untracked Files\n';
        collisionReport += '(Files in Readwise directory not in booksIDsMap)\n\n';

        const categories = ['Articles', 'Books', 'Podcasts', 'Tweets'];
        let untrackedCount = 0;
        for (const category of categories) {
          const categoryPath = `${this.settings.readwiseDir}/${category}`;
          try {
            const files = await this.app.vault.adapter.list(categoryPath);
            const mdFiles = files.files.filter(f => f.endsWith('.md'));

            const untracked = mdFiles.filter(f => !this.settings.booksIDsMap[f]);
            if (untracked.length > 0) {
              collisionReport += `### ${category} (${untracked.length} untracked)\n`;
              untracked.slice(0, 10).forEach(f => {
                const filename = f.split('/').pop();
                collisionReport += `- ${filename}\n`;
              });
              if (untracked.length > 10) {
                collisionReport += `... and ${untracked.length - 10} more\n`;
              }
              collisionReport += '\n';
              untrackedCount += untracked.length;
            }
          } catch (e) {
            // Category doesn't exist
          }
        }

        if (untrackedCount === 0) {
          collisionReport += 'None found (all files are tracked).\n\n';
        } else {
          collisionReport += `\n**Total untracked files**: ${untrackedCount}\n\n`;
          collisionReport += '**Note**: Untracked files may indicate:\n';
          collisionReport += '- Files created manually\n';
          collisionReport += '- Files from a previous sync that lost tracking data\n';
          collisionReport += '- Duplicate book titles that overwrote each other\n\n';
        }

        collisionReport += '## Summary\n';
        collisionReport += `- Total tracked books: ${Object.keys(this.settings.booksIDsMap).length}\n`;
        collisionReport += `- Total untracked files: ${untrackedCount}\n`;

        console.log(collisionReport);
        new Notice('Collision report printed to console', 5000);

        const tempFile = `${this.settings.readwiseDir}/Readwise-Collisions-${Date.now()}.md`;
        await this.app.vault.create(tempFile, collisionReport);
        const file = this.app.vault.getAbstractFileByPath(tempFile);
        if (file) {
          // @ts-ignore
          await this.app.workspace.getLeaf().openFile(file);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-find-missing',
      name: 'Find and sync missing items',
      callback: async () => {
        new Notice('Querying Readwise API for all items...', 10000);
        console.log('Readwise: Fetching all items from API...');

        // Helper function to fetch with retry and rate limiting
        // Book LIST endpoint: 20 requests per minute = 1 request per 3 seconds
        const fetchWithRetry = async (url: string, maxRetries = 5): Promise<Response> => {
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              const response = await fetch(url, {
                headers: this.getAuthHeaders()
              });

              if (response.status === 429) {
                // Rate limited - use Retry-After header
                const retryAfter = response.headers.get('Retry-After');
                const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000; // Default 60s if no header
                console.log(`Readwise: Rate limited (429). Retry-After: ${waitTime/1000}s. Waiting before retry ${attempt + 1}/${maxRetries}...`);
                new Notice(`Rate limited. Waiting ${Math.ceil(waitTime/1000)}s before retry...`, Math.min(waitTime, 10000));
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
              }

              if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
              }

              return response;
            } catch (e) {
              if (attempt === maxRetries - 1) throw e;
              const waitTime = Math.pow(2, attempt) * 1000;
              console.log(`Readwise: Error on attempt ${attempt + 1}, retrying in ${waitTime/1000}s...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
            }
          }
          throw new Error('Max retries exceeded');
        };

        try {
          // Fetch all book IDs from Readwise API
          let allApiBooks: any[] = [];
          let nextUrl: string | null = 'https://readwise.io/api/v2/books/';
          let pageCount = 0;

          while (nextUrl && pageCount < 100) { // Safety limit of 100 pages
            pageCount++;
            const response = await fetchWithRetry(nextUrl);

            const data = await response.json();
            allApiBooks = allApiBooks.concat(data.results);
            nextUrl = data.next;

            if (pageCount % 5 === 0) {
              console.log(`Readwise: Fetched ${allApiBooks.length} items so far...`);
              new Notice(`Fetched ${allApiBooks.length} items... (page ${pageCount})`, 2000);
            }

            // Book LIST endpoint limited to 20 requests/minute = 3 seconds between requests
            if (nextUrl) { // Don't wait after the last page
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }

          console.log(`Readwise: Fetched total of ${allApiBooks.length} items from API`);

          // Build set of tracked book IDs
          const trackedIds = new Set(Object.values(this.settings.booksIDsMap));
          console.log(`Readwise: Currently tracking ${trackedIds.size} items locally`);

          // Find missing items
          const missingItems = allApiBooks.filter(book => {
            const bookId = book.id.toString();
            return !trackedIds.has(bookId);
          });

          console.log(`Readwise: Found ${missingItems.length} missing items`);

          // Group by category
          const categoryCounts: { [cat: string]: number } = {};
          missingItems.forEach(item => {
            const cat = item.category || 'unknown';
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
          });

          // Create report
          let report = '# Missing Items Report\n\n';
          report += `Found **${missingItems.length}** items in Readwise that are not downloaded locally.\n\n`;
          report += '## Summary by Category\n';
          Object.entries(categoryCounts).forEach(([cat, count]) => {
            report += `- ${cat}: ${count} items\n`;
          });
          report += '\n## Missing Items (first 50)\n';
          missingItems.slice(0, 50).forEach(item => {
            report += `- [${item.category}] ${item.title} by ${item.author} (ID: ${item.id})\n`;
          });
          if (missingItems.length > 50) {
            report += `\n... and ${missingItems.length - 50} more\n`;
          }

          report += '\n## Next Steps\n';
          if (missingItems.length > 0) {
            report += 'Options to sync these items:\n';
            report += '1. Run "Force resync missing items" command to add them to refresh queue\n';
            report += '2. Use recovery script to reset lastSavedStatusID and do a full resync\n';
          } else {
            report += 'All items from Readwise are downloaded! ✓\n';
          }

          console.log(report);
          new Notice(`Found ${missingItems.length} missing items. Report created.`, 10000);

          // Save report
          const reportFile = `${this.settings.readwiseDir}/Readwise-Missing-Items-${Date.now()}.md`;
          await this.app.vault.create(reportFile, report);
          const file = this.app.vault.getAbstractFileByPath(reportFile);
          if (file) {
            // @ts-ignore
            await this.app.workspace.getLeaf().openFile(file);
          }

        } catch (e) {
          console.error('Readwise: Error finding missing items:', e);
          new Notice(`Error: ${e.message}`, 10000);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-force-resync-missing',
      name: 'Force resync missing items',
      callback: async () => {
        new Notice('Finding missing items to resync...', 10000);

        // Helper function to fetch with retry and rate limiting
        // Book LIST endpoint: 20 requests per minute = 1 request per 3 seconds
        const fetchWithRetry = async (url: string, maxRetries = 5): Promise<Response> => {
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              const response = await fetch(url, {
                headers: this.getAuthHeaders()
              });

              if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                console.log(`Readwise: Rate limited (429). Retry-After: ${waitTime/1000}s. Waiting before retry ${attempt + 1}/${maxRetries}...`);
                new Notice(`Rate limited. Waiting ${Math.ceil(waitTime/1000)}s before retry...`, Math.min(waitTime, 10000));
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
              }

              if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
              }

              return response;
            } catch (e) {
              if (attempt === maxRetries - 1) throw e;
              const waitTime = Math.pow(2, attempt) * 1000;
              console.log(`Readwise: Error on attempt ${attempt + 1}, retrying in ${waitTime/1000}s...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
            }
          }
          throw new Error('Max retries exceeded');
        };

        try {
          // Fetch all book IDs from Readwise API
          let allApiBooks: any[] = [];
          let nextUrl: string | null = 'https://readwise.io/api/v2/books/';
          let pageCount = 0;

          while (nextUrl && pageCount < 100) {
            pageCount++;
            const response = await fetchWithRetry(nextUrl);

            const data = await response.json();
            allApiBooks = allApiBooks.concat(data.results);
            nextUrl = data.next;

            if (pageCount % 5 === 0) {
              console.log(`Readwise: Fetched ${allApiBooks.length} items so far...`);
              new Notice(`Fetched ${allApiBooks.length} items... (page ${pageCount})`, 2000);
            }

            // Book LIST endpoint limited to 20 requests/minute = 3 seconds between requests
            if (nextUrl) {
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }

          // Build set of tracked book IDs
          const trackedIds = new Set(Object.values(this.settings.booksIDsMap));

          // Find missing book IDs
          const missingBookIds = allApiBooks
            .filter(book => !trackedIds.has(book.id.toString()))
            .map(book => book.id.toString());

          if (missingBookIds.length === 0) {
            new Notice('No missing items found!', 5000);
            return;
          }

          console.log(`Readwise: Adding ${missingBookIds.length} missing items to refresh queue`);

          // Add to booksToRefresh
          this.settings.booksToRefresh = [...new Set([...this.settings.booksToRefresh, ...missingBookIds])];
          await this.saveSettings();

          new Notice(`Added ${missingBookIds.length} missing items to sync queue. Starting sync...`, 5000);

          // Trigger sync
          await this.syncBookHighlights();

        } catch (e) {
          console.error('Readwise: Error resyncing missing items:', e);
          new Notice(`Error: ${e.message}`, 10000);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-sync-category',
      name: 'Sync specific category only',
      callback: async () => {
        const categoryMap: { [key: string]: string } = {
          'articles': 'Articles',
          'books': 'Books',
          'tweets': 'Tweets',
          'podcasts': 'Podcasts'
        };

        const modal = new Modal(this.app);
        modal.titleEl.setText("Select category to sync");
        modal.contentEl.createEl('p', {
          text: 'This will fetch missing items from the selected category only.',
        });

        const selectContainer = modal.contentEl.createEl('div');
        const select = selectContainer.createEl('select');
        Object.entries(categoryMap).forEach(([key, label]) => {
          select.createEl('option', { text: label, value: key });
        });

        const buttonsContainer = modal.contentEl.createEl('div', { cls: "rw-modal-btns" });
        const cancelBtn = buttonsContainer.createEl("button", { text: "Cancel" });
        const confirmBtn = buttonsContainer.createEl("button", { text: "Sync Category" });

        cancelBtn.onclick = () => modal.close();
        confirmBtn.onclick = async () => {
          const selectedCategory = select.value;
          modal.close();

          new Notice(`Fetching ${categoryMap[selectedCategory]} from Readwise...`, 10000);

          // Helper function to fetch with retry and rate limiting
          // Book LIST endpoint: 20 requests per minute = 1 request per 3 seconds
          const fetchWithRetry = async (url: string, maxRetries = 5): Promise<Response> => {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
              try {
                const response = await fetch(url, {
                  headers: this.getAuthHeaders()
                });

                if (response.status === 429) {
                  const retryAfter = response.headers.get('Retry-After');
                  const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                  console.log(`Readwise: Rate limited (429). Retry-After: ${waitTime/1000}s. Waiting before retry ${attempt + 1}/${maxRetries}...`);
                  new Notice(`Rate limited. Waiting ${Math.ceil(waitTime/1000)}s before retry...`, Math.min(waitTime, 10000));
                  await new Promise(resolve => setTimeout(resolve, waitTime));
                  continue;
                }

                if (!response.ok) {
                  throw new Error(`API request failed: ${response.status} ${response.statusText}`);
                }

                return response;
              } catch (e) {
                if (attempt === maxRetries - 1) throw e;
                const waitTime = Math.pow(2, attempt) * 1000;
                console.log(`Readwise: Error on attempt ${attempt + 1}, retrying in ${waitTime/1000}s...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
              }
            }
            throw new Error('Max retries exceeded');
          };

          try {
            // Fetch all books of this category
            let categoryBooks: any[] = [];
            let nextUrl: string | null = `https://readwise.io/api/v2/books/?category=${selectedCategory}`;
            let pageCount = 0;

            while (nextUrl) {
              pageCount++;
              const response = await fetchWithRetry(nextUrl);

              const data = await response.json();
              categoryBooks = categoryBooks.concat(data.results);
              nextUrl = data.next;

              if (pageCount % 3 === 0) {
                console.log(`Readwise: Fetched ${categoryBooks.length} ${selectedCategory}... (page ${pageCount})`);
                new Notice(`Fetched ${categoryBooks.length} ${selectedCategory}... (page ${pageCount})`, 2000);
              }

              // Book LIST endpoint limited to 20 requests/minute = 3 seconds between requests
              if (nextUrl) {
                await new Promise(resolve => setTimeout(resolve, 3000));
              }
            }

            // Find missing ones
            const trackedIds = new Set(Object.values(this.settings.booksIDsMap));
            const missingBookIds = categoryBooks
              .filter(book => !trackedIds.has(book.id.toString()))
              .map(book => book.id.toString());

            if (missingBookIds.length === 0) {
              new Notice(`All ${categoryMap[selectedCategory]} are already synced!`, 5000);
              return;
            }

            console.log(`Readwise: Found ${missingBookIds.length} missing ${selectedCategory}`);

            // Add to refresh queue and sync
            this.settings.booksToRefresh = [...new Set([...this.settings.booksToRefresh, ...missingBookIds])];
            await this.saveSettings();

            new Notice(`Syncing ${missingBookIds.length} missing ${categoryMap[selectedCategory]}...`, 5000);
            await this.syncBookHighlights();

          } catch (e) {
            console.error(`Readwise: Error syncing ${selectedCategory}:`, e);
            new Notice(`Error: ${e.message}`, 10000);
          }
        };

        modal.open();
      }
    });
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!ctx.sourcePath.startsWith(this.settings.readwiseDir)) {
        return;
      }
      let matches: string[];
      try {
        // @ts-ignore
        matches = [...ctx.getSectionInfo(el).text.matchAll(/__(.+)__/g)].map((a) => a[1]);
      } catch (TypeError) {
        // failed interaction with a Dataview element
        return;
      }
      const hypers = el.findAll("strong").filter(e => matches.contains(e.textContent));
      hypers.forEach(strongEl => {
        const replacement = el.createEl('span');
        while (strongEl.firstChild) {
          replacement.appendChild(strongEl.firstChild);
        }
        replacement.addClass("rw-hyper-highlight");
        strongEl.replaceWith(replacement);
      });
    });

    this.addSettingTab(new ReadwiseSettingTab(this.app, this));

    // ensure workspace is settled; this ensures cache is loaded
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.isSyncing && this.settings.currentSyncStatusID) {
        await this.getExportStatus(this.settings.currentSyncStatusID);
      } else {
        // we probably got some unhandled error...
        this.settings.isSyncing = false;
        await this.saveSettings();
      }

      if (this.settings.triggerOnLoad) {
        await this.syncBookHighlights(undefined, true);
      }

      await this.configureSchedule();

      this.app.vault.on("delete", async (file) => {
        const bookId = this.settings.booksIDsMap[file.path];

        if (bookId) {
          // NOTE: because `on(delete)` also adds to `booksToRefresh`,
          // the ID will be duplicated in `booksToRefresh`.
          await this.addBookToRefresh(bookId);
        }

        delete this.settings.booksIDsMap[file.path];

        // BUG: `on("delete")` events have no sequantial guarantees.
        // meaning: if a user deletes many files at once,
        // there is no guarantee that the event will be handled
        // in any specific order. this can lead to reality
        // drifting as book ID is deleted/saved as all the delete
        // events compete to remove the book ID from the map and save.
        await this.saveSettings();
      });
    });
  }

  onunload() {
    // we're not doing anything here for now...
    return;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getObsidianClientID() {
    let obsidianClientId = window.localStorage.getItem('rw-ObsidianClientId');
    if (obsidianClientId) {
      return obsidianClientId;
    } else {
      obsidianClientId = Math.random().toString(36).substring(2, 15);
      window.localStorage.setItem('rw-ObsidianClientId', obsidianClientId);
      return obsidianClientId;
    }
  }

  async getUserAuthToken(button: HTMLElement, attempt = 0) {
    let uuid = this.getObsidianClientID();

    if (attempt === 0) {
      window.open(`${baseURL}/api_auth?token=${uuid}&service=obsidian`);
    }

    let response, data: ReadwiseAuthResponse;
    try {
      response = await fetch(
        `${baseURL}/api/auth?token=${uuid}`
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in getUserAuthToken: ", e);
    }
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("Readwise Official plugin: bad response in getUserAuthToken: ", response);
      this.showInfoStatus(button.parentElement, "Authorization failed. Try again", "rw-error");
      return;
    }
    if (data.userAccessToken) {
      console.log("Readwise Official plugin: successfully authenticated with Readwise");
      this.settings.token = data.userAccessToken;
      await this.saveSettings();
    } else {
      if (attempt > 20) {
        console.log('Readwise Official plugin: reached attempt limit in getUserAuthToken');
        return;
      }
      console.log(`Readwise Official plugin: didn't get token data, retrying (attempt ${attempt + 1})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.getUserAuthToken(button, attempt + 1);
    }
    await this.saveSettings();
    return true;
  }

  encodeReadwiseBookId(rawBookId?: string): string | undefined {
    if (rawBookId) {
      return rawBookId.toString()
    }
    return undefined;
  }

  encodeReaderDocumentId(rawReaderDocumentId?: string) : string | undefined {
    if (rawReaderDocumentId) {
      return `readerdocument:${rawReaderDocumentId}`;
    }
    return undefined;
  }

  decodeReaderDocumentId(readerDocumentId?: string) : string | undefined {
    if (!readerDocumentId || !readerDocumentId.startsWith("readerdocument:")) {
      return undefined;
    }
    return readerDocumentId.replace(/^readerdocument:/, "");
  }
}

class ReadwiseSettingTab extends PluginSettingTab {
  plugin: ReadwisePlugin;

  constructor(app: App, plugin: ReadwisePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }


  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    containerEl.createEl('h1', { text: 'Readwise Official' });
    containerEl.createEl('p', { text: 'Created by ' }).createEl('a', { text: 'Readwise', href: 'https://readwise.io' });
    containerEl.getElementsByTagName('p')[0].appendText(' 📚');
    containerEl.createEl('h2', { text: 'Settings' });

    if (this.plugin.settings.token) {
      new Setting(containerEl)
        .setName("Sync your Readwise data with Obsidian")
        .setDesc("On first sync, the Readwise plugin will create a new folder containing all your highlights")
        .setClass('rw-setting-sync')
        .addButton((button) => {
          button.setCta().setTooltip("Once the sync begins, you can close this plugin page")
            .setButtonText('Initiate Sync')
            .onClick(async () => {
              if (this.plugin.settings.isSyncing) {
                // NOTE: This is used to prevent multiple syncs at the same time. However, if a previous sync fails,
                //  it can stop new syncs from happening. Make sure to set isSyncing to false
                //  if there's ever errors/failures in previous sync attempts, so that
                //  we don't block syncing subsequent times.
                new Notice("Readwise sync already in progress");
              } else {
                this.plugin.clearInfoStatus(containerEl);
                await this.plugin.syncBookHighlights();
              }
            });
        });
      let el = containerEl.createEl("div", { cls: "rw-info-container" });
      containerEl.find(".rw-setting-sync > .setting-item-control ").prepend(el);

      new Setting(containerEl)
        .setName("Customize formatting options")
        .setDesc("You can customize which items export to Obsidian and how they appear from the Readwise website")
        .addButton((button) => {
          button.setButtonText("Customize").onClick(() => {
            window.open(`${baseURL}/export/obsidian/preferences`);
          });
        });

      new Setting(containerEl)
        .setName('Customize base folder')
        .setDesc("By default, the plugin will save all your highlights into a folder named Readwise")
        // TODO: change this to search filed when the API is exposed (https://github.com/obsidianmd/obsidian-api/issues/22)
        .addText(text => text
          .setPlaceholder('Defaults to: Readwise')
          .setValue(this.plugin.settings.readwiseDir)
          .onChange(async (value) => {
            this.plugin.settings.readwiseDir = normalizePath(value || "Readwise");
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('Configure resync frequency')
        .setDesc("If not set to Manual, Readwise will automatically resync with Obsidian when the app is open at the specified interval")
        .addDropdown(dropdown => {
          dropdown.addOption("0", "Manual");
          dropdown.addOption("60", "Every 1 hour");
          dropdown.addOption((12 * 60).toString(), "Every 12 hours");
          dropdown.addOption((24 * 60).toString(), "Every 24 hours");
          dropdown.addOption((7 * 24 * 60).toString(), "Every week");

          // select the currently-saved option
          dropdown.setValue(this.plugin.settings.frequency);

          dropdown.onChange(async (newValue) => {
            // update the plugin settings
            this.plugin.settings.frequency = newValue;
            await this.plugin.saveSettings();

            // destroy & re-create the scheduled task
            this.plugin.configureSchedule();
          });
        });
      new Setting(containerEl)
        .setName("Sync automatically when Obsidian opens")
        .setDesc("If enabled, Readwise will automatically resync with Obsidian each time you open the app")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.triggerOnLoad);
          toggle.onChange(async (val) => {
            this.plugin.settings.triggerOnLoad = val;
            await this.plugin.saveSettings();
          });
        }
        );
      new Setting(containerEl)
        .setName("Resync deleted files")
        .setDesc("If enabled, you can refresh individual items by deleting the file in Obsidian and initiating a resync")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.refreshBooks);
          toggle.onChange(async (val) => {
            this.plugin.settings.refreshBooks = val;
            await this.plugin.saveSettings();
            if (val) {
              await this.plugin.syncBookHighlights();
            }
          });
        }
        );

      if (this.plugin.settings.lastSyncFailed) {
        this.plugin.showInfoStatus(containerEl.find(".rw-setting-sync .rw-info-container").parentElement, "Last sync failed", "rw-error");
      }
    } else {
      new Setting(containerEl)
        .setName("Connect Obsidian to Readwise")
        .setClass("rw-setting-connect")
        .setDesc("The Readwise plugin enables automatic syncing of all your highlights from Kindle, Instapaper, Pocket, and more. Note: Requires Readwise account.")
        .addButton((button) => {
          button.setButtonText("Connect").setCta().onClick(async (evt) => {
            const success = await this.plugin.getUserAuthToken(evt.target as HTMLElement);
            if (success) {
              // re-render the settings
              this.display();

              this.plugin.notice("Readwise connected", true);
            }
          });
        });
      let el = containerEl.createEl("div", { cls: "rw-info-container" });
      containerEl.find(".rw-setting-connect > .setting-item-control ").prepend(el);
    }
    const help = containerEl.createEl('p',);
    help.innerHTML = "Question? Please see our <a href='https://help.readwise.io/article/125-how-does-the-readwise-to-obsidian-export-integration-work'>Documentation</a> or email us at <a href='mailto:hello@readwise.io'>hello@readwise.io</a> 🙂";
  }
}
