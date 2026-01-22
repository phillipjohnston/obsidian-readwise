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
import { Logger, LogLevel } from './logger';

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

interface CachedBook {
  id: string;
  title: string;
  author: string;
  category: string;
  source_url?: string;
  num_highlights: number;
  last_highlight_at?: string;
  updated_at?: string;
}

interface ReadwiseBooksCache {
  version: number;
  lastUpdated: string;
  totalBooks: number;
  byId: { [bookId: string]: CachedBook };
  byCategory: {
    articles: string[];
    books: string[];
    tweets: string[];
    podcasts: string[];
  };
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

  /** Log level for console output */
  logLevel: LogLevel;
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
  "reimportShowConfirmation": true,
  "logLevel": LogLevel.WARN
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
  booksCache: ReadwiseBooksCache | null = null;
  logger: Logger;

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
    const hasItemsToRefresh = this.settings.booksToRefresh.length > 0 || this.settings.failedBooks.length > 0;

    if (statusID <= this.settings.lastSavedStatusID && !hasItemsToRefresh) {
      this.logger.info(`Already saved data from export ${statusID}`);
      await this.handleSyncSuccess(buttonContext);
      this.notice("Readwise data is already up to date", false, 4);
      return;
    }

    if (statusID <= this.settings.lastSavedStatusID && hasItemsToRefresh) {
      this.logger.info(`Export ${statusID} already saved, but forcing download for ${this.settings.booksToRefresh.length} queued items`);
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
        this.logger.debug(`getExportStatus: status=${data.taskStatus}, booksExported=${data.booksExported}/${data.totalBooks}, artifactIds=${data.artifactIds?.length || 0}`);

        const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY'];
        const SUCCESS_STATUSES = ['SUCCESS'];

        // Track if export is making progress
        const currentBooksExported = data.booksExported || 0;
        const isStuck = data.taskStatus === 'UNKNOWN' && currentBooksExported === lastBooksExported && currentBooksExported > 0;
        const newUnknownCount = data.taskStatus === 'UNKNOWN' ? unknownStatusCount + 1 : 0;

        // If UNKNOWN and no progress for 30 seconds, or UNKNOWN persists for 60 seconds total
        if (data.taskStatus === 'UNKNOWN' && (unknownStatusCount >= 60 || (isStuck && unknownStatusCount >= 30))) {
          this.logger.warn(`UNKNOWN status persisted for ${unknownStatusCount} attempts`);
          this.logger.debug("data at timeout:", data);

          // Check if export is actually complete
          const isComplete = data.isFinished || (data.booksExported && data.totalBooks && data.booksExported >= data.totalBooks);

          if (isComplete) {
            this.logger.info("Export appears complete despite UNKNOWN status");
            // Treat as success
            await downloadUnprocessedArtifacts(data.artifactIds);
            await this.acknowledgeSyncCompleted(buttonContext);
            await this.handleSyncSuccess(buttonContext, "Synced!", statusID);
            this.notice("Readwise sync completed", true, 1, true);
            this.logger.info("completed sync");
            // @ts-ignore
            if (this.app.isMobile) {
              this.notice("If you don't see all of your Readwise files, please reload the Obsidian app", true,);
            }
            return;
          } else {
            this.logger.error("Export appears incomplete, treating as error");
            await this.handleSyncError(buttonContext, "Sync timed out with UNKNOWN status");
            return;
          }
        }

        if (WAITING_STATUSES.includes(data.taskStatus) || data.taskStatus === 'UNKNOWN') {
          if (data.taskStatus === 'UNKNOWN') {
            const progressInfo = isStuck ? ` - STUCK at ${currentBooksExported}/${data.totalBooks}` : ` - progressing (${currentBooksExported}/${data.totalBooks})`;
            this.logger.warn(`UNKNOWN status encountered (attempt ${newUnknownCount}/60)${progressInfo}`);
          }
          if (data.booksExported) {
            const progressMsg = `Exporting Readwise data (${data.booksExported} / ${data.totalBooks}) ...`;
            this.notice(progressMsg, false, 35, true);
          } else {
            this.notice("Building export...");
          }
          // process any artifacts available while the export is still being generated
          await downloadUnprocessedArtifacts(data.artifactIds);

          // Intelligent polling interval based on export state
          let pollInterval = 3000; // Default: 3 seconds
          if (data.booksExported === 0) {
            // Initial state - export not started yet
            pollInterval = 5000; // 5 seconds
          } else if (data.booksExported > 0 && data.booksExported < data.totalBooks * 0.1) {
            // Early stage (first 10%)
            pollInterval = 4000; // 4 seconds
          } else if (data.booksExported >= data.totalBooks * 0.9) {
            // Near completion (last 10%)
            pollInterval = 2000; // 2 seconds - more responsive near end
          }

          this.logger.debug(`Waiting ${pollInterval/1000}s before next poll...`);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          // then keep polling
          await this.getExportStatus(statusID, buttonContext, processedArtifactIds, newUnknownCount, currentBooksExported);
        } else if (SUCCESS_STATUSES.includes(data.taskStatus)) {
          // make sure all artifacts are processed
          await downloadUnprocessedArtifacts(data.artifactIds);

          await this.acknowledgeSyncCompleted(buttonContext);
          await this.handleSyncSuccess(buttonContext, "Synced!", statusID);
          this.notice("Readwise sync completed", true, 1, true);
          this.logger.info("completed sync");
          // @ts-ignore
          if (this.app.isMobile) {
            this.notice("If you don't see all of your Readwise files, please reload the Obsidian app", true,);

          }
        } else {
          this.logger.error("unexpected status in getExportStatus: ", data);
          await this.handleSyncError(buttonContext, "Sync failed - unexpected status: " + data.taskStatus);
          return;
        }
      } else {
        this.logger.error("bad response in getExportStatus: ", response);
        await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      }
    } catch (e) {
      this.logger.error("fetch failed in getExportStatus: ", e);
      await this.handleSyncError(buttonContext, "Sync failed");
    }
  }

  /** Requests the archive from Readwise, polling until it's ready */
  async queueExport(buttonContext?: ButtonComponent, statusId?: number, auto?: boolean) {
    if (this.settings.isSyncing) {
      this.notice("Readwise sync already in progress", true);
      return;
    }

    this.logger.info('queueExport, requesting archive...');
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
    this.logger.debug("endpoint: ", url);
    let response, data: ExportRequestResponse;
    try {
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      );
    } catch (e) {
      this.logger.error("fetch failed in queueExport: ", e);
    }

    if (response && response.ok) {
      data = await response.json();

      if (data.latest_id <= this.settings.lastSavedStatusID) {
        await this.handleSyncSuccess(buttonContext);
        this.notice("Readwise data is already up to date", false, 4, true);
        this.logger.info("Readwise data is already up to date");
        //return;
      }

      // save the sync status ID so it can be polled until the archive is ready
      this.settings.currentSyncStatusID = data.latest_id;
      await this.saveSettings();
      this.logger.debug("saved currentSyncStatusID", this.settings.currentSyncStatusID);

      if (response.status === 201) {
        this.notice("Syncing Readwise data");
        await this.getExportStatus(this.settings.currentSyncStatusID, buttonContext);
        this.logger.info('queueExport done');
      } else {
        // Status 200 - export already exists
        // But if we have items queued for refresh, we should still download to get them
        const hasItemsToRefresh = this.settings.booksToRefresh.length > 0 || this.settings.failedBooks.length > 0;

        if (hasItemsToRefresh) {
          this.logger.info(`Export exists but we have ${this.settings.booksToRefresh.length} books to refresh and ${this.settings.failedBooks.length} failed books - forcing download`);
          this.notice("Downloading refreshed items...");
          await this.getExportStatus(this.settings.currentSyncStatusID, buttonContext);
          this.logger.info('queueExport done');
        } else {
          await this.handleSyncSuccess(buttonContext, "Synced", data.latest_id);
          this.notice("Latest Readwise sync already happened on your other device. Data should be up to date", false, 4, true);
        }
      }
    } else {
      this.logger.error("bad response in queueExport: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }

    this.logger.debug("queueExport end");
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

  /** Check if filename collides with existing file tracking a different book ID.
   * Returns a unique filename by appending book ID if collision detected. */
  resolveFilenameCollision(baseFilename: string, bookID: string): string {
    // Check if this exact filename already tracks a different book ID
    const existingBookID = this.settings.booksIDsMap[baseFilename];

    if (existingBookID && existingBookID !== bookID) {
      // Collision detected - filename exists and tracks a different book
      this.logger.warn(`COLLISION DETECTED: ${baseFilename}`);
      this.logger.warn(`  Existing book ID: ${existingBookID}`);
      this.logger.warn(`  New book ID: ${bookID}`);

      // Append book ID to make it unique: "Title.md" -> "Title (ID-12345).md"
      const lastDotIndex = baseFilename.lastIndexOf('.');
      const nameWithoutExt = baseFilename.substring(0, lastDotIndex);
      const ext = baseFilename.substring(lastDotIndex);
      const uniqueFilename = `${nameWithoutExt} (ID-${bookID})${ext}`;

      this.logger.debug(`  Resolved to: ${uniqueFilename}`);
      return uniqueFilename;
    }

    return baseFilename;
  }

  async downloadArtifact(artifactId: number, buttonContext: ButtonComponent): Promise<void> {
    this.logger.info(`downloadArtifact: Starting download of artifact ${artifactId}`);

    // Check if we're doing a targeted refresh
    const hasTargetedRefresh = this.settings.booksToRefresh.length > 0 || this.settings.failedBooks.length > 0;
    const targetBookIds = new Set([...this.settings.booksToRefresh, ...this.settings.failedBooks]);

    if (hasTargetedRefresh) {
      this.logger.debug(`downloadArtifact: Targeted refresh for ${targetBookIds.size} specific items`);
      this.logger.debug(`downloadArtifact: Target IDs:`, Array.from(targetBookIds));
    }

    // download archive from this endpoint
    let artifactURL = `${baseURL}/api/v2/download_artifact/${artifactId}`;

    let response, blob;
    try {
      response = await fetch(
        artifactURL, { headers: this.getAuthHeaders() }
      );
    } catch (e) {
      this.logger.error("fetch failed in downloadExport: ", e);
    }
    if (response && response.ok) {
      blob = await response.blob();
    } else {
      this.logger.error("bad response in downloadExport: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      throw new Error(`Readwise: error while fetching artifact ${artifactId}`);
    }

    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();
    this.logger.debug(`downloadArtifact: Artifact ${artifactId} contains ${entries.length} entries`);

    const foundTargetIds = new Set<string>();
    const allBookIdsInArtifact: string[] = [];
    let processedCount = 0;
    let skippedCount = 0;

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

          // Track all book IDs in artifact for diagnostic purposes
          if (bookID && hasTargetedRefresh) {
            allBookIdsInArtifact.push(bookID);
          }

          // If doing targeted refresh, skip entries not in target list
          if (hasTargetedRefresh && bookID && !targetBookIds.has(bookID)) {
            skippedCount++;
            continue; // Skip this entry entirely
          }

          // Track if this is one of our target items
          if (hasTargetedRefresh && bookID && targetBookIds.has(bookID)) {
            foundTargetIds.add(bookID);
            this.logger.debug(`downloadArtifact: ✓ FOUND TARGET ITEM - bookID: ${bookID} from entry ${entry.filename}`);
          }

          const undefinedBook = !bookID || !processedFileName;
          if (undefinedBook && !isReadwiseSyncFile) {
            this.logger.error(`Error while processing entry: ${entry.filename}`);
          }

          // Check for filename collision and resolve before processing
          let finalProcessedFileName = processedFileName;
          if (bookID && !isReadwiseSyncFile) {
            finalProcessedFileName = this.resolveFilenameCollision(processedFileName, bookID);
          }

          processedCount++;

          // write the full document text file
          if (data.full_document_text && data.full_document_text_path) {
            let processedFullDocumentTextFileName = data.full_document_text_path.replace(/^Readwise/, this.settings.readwiseDir);
            // Check for collision and resolve
            processedFullDocumentTextFileName = this.resolveFilenameCollision(processedFullDocumentTextFileName, bookID);
            this.logger.debug(`downloadArtifact: Writing full document text for bookID ${bookID}: ${processedFullDocumentTextFileName}`);
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
            this.logger.debug(`downloadArtifact: Writing highlights file for bookID ${bookID}: ${finalProcessedFileName}`);
            // track the book
            this.settings.booksIDsMap[finalProcessedFileName] = bookID;
            // ensure the directory exists
            await this.createDirForFile(finalProcessedFileName);
            if (await this.fs.exists(finalProcessedFileName)) {
              // if the file already exists we need to append content to existing one
              const existingContent = await this.fs.read(finalProcessedFileName);
              const existingContentHash = Md5.hashStr(existingContent).toString();
              if (existingContentHash !== data.last_content_hash) {
                // content has been modified (it differs from the previously exported full document)
                this.logger.debug(`downloadArtifact: File exists and was modified locally, appending new content`);
                contentToSave = existingContent.trimEnd() + "\n" + data.append_only_content;
              } else {
                this.logger.debug(`downloadArtifact: File exists and unchanged, overwriting with full content`);
              }
            } else {
              this.logger.debug(`downloadArtifact: Creating new file`);
            }
            await this.fs.write(finalProcessedFileName, contentToSave);
            this.logger.debug(`downloadArtifact: Successfully wrote file for bookID ${bookID}`);
          } else {
            this.logger.debug(`downloadArtifact: No content to save for bookID ${bookID} (entry: ${entry.filename})`);
          }

          // save the entry in settings to ensure that it can be
          // retried later when deleted files are re-synced if
          // the user has `settings.refreshBooks` enabled
          if (bookID) await this.saveSettings();
        } catch (e) {
          this.logger.error(`error writing ${finalProcessedFileName}:`, e);
          this.notice(`Readwise: error while writing ${finalProcessedFileName}: ${e}`, true, 4, true);
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

    // Summary logging for targeted refresh
    if (hasTargetedRefresh) {
      this.logger.debug(`downloadArtifact SUMMARY for artifact ${artifactId}:`);
      this.logger.debug(`  Total entries in artifact: ${entries.length}`);
      this.logger.debug(`  Processed (target items): ${processedCount}`);
      this.logger.debug(`  Skipped (not in target list): ${skippedCount}`);
      this.logger.debug(`  Target items found: ${foundTargetIds.size} of ${targetBookIds.size}`);

      if (foundTargetIds.size > 0) {
        this.logger.debug(`  Found IDs:`, Array.from(foundTargetIds));
      }

      const missingTargetIds = Array.from(targetBookIds).filter(id => !foundTargetIds.has(id));
      if (missingTargetIds.length > 0) {
        this.logger.debug(`  ⚠️ NOT FOUND in this artifact:`, missingTargetIds);
        this.logger.debug(`  Sample of what IS in artifact (first 10):`, allBookIdsInArtifact.slice(0, 10));
        this.logger.debug(`  Sample of what IS in artifact (last 10):`, allBookIdsInArtifact.slice(-10));
      }
    }

    // close the ZipReader
    await zipReader.close();

    // wait for the metadata cache to process created/updated documents
    await new Promise<void>((resolve) => {
      const timeoutSeconds = 15;
      this.logger.debug(`waiting for metadata cache processing for up to ${timeoutSeconds}s...`)
      const timeout = setTimeout(() => {
        this.app.metadataCache.offref(eventRef);
        this.logger.warn("metadata cache processing timeout reached.");
        resolve();
      }, timeoutSeconds * 1000);

      const eventRef = this.app.metadataCache.on("resolved", () => {
        this.app.metadataCache.offref(eventRef);
        clearTimeout(timeout);
        this.logger.debug("metadata cache processing has finished.");
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
      this.logger.error("fetch failed to acknowledged sync: ", e);
    }
    if (response && response.ok) {
      return;
    } else {
      this.logger.error("bad response in acknowledge sync: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
  }

  getCachePath(): string {
    // @ts-ignore - accessing private property
    return `${this.manifest.dir}/cache.json`;
  }

  async loadBooksCache(): Promise<ReadwiseBooksCache | null> {
    try {
      const cachePath = this.getCachePath();
      const cacheExists = await this.app.vault.adapter.exists(cachePath);
      if (!cacheExists) {
        return null;
      }

      const cacheData = await this.app.vault.adapter.read(cachePath);
      const cache = JSON.parse(cacheData) as ReadwiseBooksCache;

      // Validate cache version
      if (cache.version !== 1) {
        this.logger.warn('Cache version mismatch, ignoring cache');
        return null;
      }

      this.logger.info(`Loaded cache with ${cache.totalBooks} books from ${cache.lastUpdated}`);
      return cache;
    } catch (e) {
      this.logger.error('Error loading cache:', e);
      return null;
    }
  }

  async saveBooksCache(cache: ReadwiseBooksCache): Promise<void> {
    try {
      const cachePath = this.getCachePath();
      const cacheData = JSON.stringify(cache, null, 2);
      await this.app.vault.adapter.write(cachePath, cacheData);
      this.logger.info(`Saved cache with ${cache.totalBooks} books to ${cachePath}`);
    } catch (e) {
      this.logger.error('Error saving cache:', e);
    }
  }

  async clearBooksCache(): Promise<void> {
    try {
      const cachePath = this.getCachePath();
      const cacheExists = await this.app.vault.adapter.exists(cachePath);
      if (cacheExists) {
        await this.app.vault.adapter.remove(cachePath);
        this.booksCache = null;
        this.logger.info('Cache cleared');
      }
    } catch (e) {
      this.logger.error('Error clearing cache:', e);
    }
  }

  isCacheStale(cache: ReadwiseBooksCache | null): boolean {
    if (!cache) return true;

    const cacheAge = Date.now() - new Date(cache.lastUpdated).getTime();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    return cacheAge > SEVEN_DAYS_MS;
  }

  getCacheAgeDescription(cache: ReadwiseBooksCache | null): string {
    if (!cache) return "No cache";

    const cacheDate = new Date(cache.lastUpdated);
    const ageMs = Date.now() - cacheDate.getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

    if (ageDays === 0) return "Today";
    if (ageDays === 1) return "Yesterday";
    return `${ageDays} days ago`;
  }

  async buildBooksCache(showNotices: boolean = true): Promise<ReadwiseBooksCache | null> {
    if (showNotices) {
      new Notice('Building book cache from Readwise API...', 10000);
    }

    const fetchWithRetry = async (url: string, maxRetries = 5): Promise<Response> => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await fetch(url, {
            headers: this.getAuthHeaders()
          });

          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
            this.logger.warn(`Rate limited (429). Retry-After: ${waitTime/1000}s. Waiting before retry ${attempt + 1}/${maxRetries}...`);
            if (showNotices) {
              new Notice(`Rate limited. Waiting ${Math.ceil(waitTime/1000)}s before retry...`, Math.min(waitTime, 10000));
            }
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
          this.logger.debug(`Error on attempt ${attempt + 1}, retrying in ${waitTime/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
      throw new Error('Max retries exceeded');
    };

    try {
      let allApiBooks: any[] = [];
      let nextUrl: string | null = 'https://readwise.io/api/v2/books/';
      let pageCount = 0;

      while (nextUrl && pageCount < 100) {
        pageCount++;
        const response = await fetchWithRetry(nextUrl);
        const data = await response.json();
        allApiBooks = allApiBooks.concat(data.results);
        nextUrl = data.next;

        if (pageCount % 5 === 0 && showNotices) {
          this.logger.debug(`Cached ${allApiBooks.length} books... (page ${pageCount})`);
          new Notice(`Caching books: ${allApiBooks.length} so far...`, 2000);
        }

        if (nextUrl) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      // Build cache structure
      const cache: ReadwiseBooksCache = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        totalBooks: allApiBooks.length,
        byId: {},
        byCategory: {
          articles: [],
          books: [],
          tweets: [],
          podcasts: []
        }
      };

      // Populate indexes
      allApiBooks.forEach(book => {
        const bookId = book.id.toString();
        const category = book.category || 'articles';

        cache.byId[bookId] = {
          id: bookId,
          title: book.title || 'Untitled',
          author: book.author || 'Unknown',
          category: category,
          source_url: book.source_url,
          num_highlights: book.num_highlights || 0,
          last_highlight_at: book.last_highlight_at,
          updated_at: book.updated
        };

        // Add to category index
        if (category in cache.byCategory) {
          cache.byCategory[category as keyof typeof cache.byCategory].push(bookId);
        }
      });

      // Save to disk
      await this.saveBooksCache(cache);

      // Store in memory
      this.booksCache = cache;

      if (showNotices) {
        new Notice(`Book cache built successfully: ${cache.totalBooks} books`, 5000);
      }

      return cache;
    } catch (e) {
      this.logger.error('Error building cache:', e);
      if (showNotices) {
        new Notice(`Error building cache: ${e.message}`, 10000);
      }
      return null;
    }
  }

  /** Fetch and save highlights for specific book IDs directly via API.
   * Bypasses export system for faster targeted refresh. */
  async syncSpecificBooksDirect(bookIds: string[]): Promise<{ success: number, failed: string[] }> {
    this.logger.info(`syncSpecificBooksDirect: Syncing ${bookIds.length} books via direct API`);

    const results = { success: 0, failed: [] as string[] };

    for (const bookId of bookIds) {
      try {
        this.logger.debug(`syncSpecificBooksDirect: Fetching book ${bookId}`);

        // Fetch book metadata
        const bookResponse = await fetch(`${baseURL}/api/v2/books/${bookId}/`, {
          headers: this.getAuthHeaders()
        });

        if (!bookResponse.ok) {
          this.logger.error(`Failed to fetch book ${bookId}: ${bookResponse.status}`);
          results.failed.push(bookId);
          continue;
        }

        const book = await bookResponse.json();
        this.logger.debug(`Book ${bookId}: "${book.title}" (${book.category}), ${book.num_highlights} highlights`);

        // Skip if no highlights
        if (book.num_highlights === 0) {
          this.logger.debug(`Skipping book ${bookId} - no highlights`);
          results.failed.push(bookId);
          continue;
        }

        // Fetch highlights
        const highlightsResponse = await fetch(`${baseURL}/api/v2/books/${bookId}/highlights/`, {
          headers: this.getAuthHeaders()
        });

        const category = book.category.charAt(0).toUpperCase() + book.category.slice(1);
        let content = `# ${book.title}\n\n`;
        content += `**Author:** ${book.author || 'Unknown'}\n`;
        content += `**Category:** ${book.category}\n`;
        if (book.source_url) {
          content += `**Source:** ${book.source_url}\n`;
        }
        content += `\n---\n\n`;

        if (!highlightsResponse.ok) {
          this.logger.error(`Failed to fetch highlights for book ${bookId}: ${highlightsResponse.status}`);

          // Create stub file documenting the failure
          content += `## ⚠️ Sync Error\n\n`;
          content += `**Status:** Failed to sync highlights from Readwise API\n\n`;
          content += `**Error:** API returned ${highlightsResponse.status} (${highlightsResponse.statusText})\n\n`;
          content += `**Book ID:** ${bookId}\n\n`;
          content += `**Expected Highlights:** ${book.num_highlights}\n\n`;
          content += `**Details:**\n`;
          content += `- The Readwise API reports this book has ${book.num_highlights} highlight(s)\n`;
          content += `- However, the highlights endpoint returned a 404 error\n`;
          content += `- This indicates a server-side data issue with this book\n\n`;
          content += `**What you can do:**\n`;
          content += `1. Try viewing this book on readwise.io/library to see if highlights appear there\n`;
          content += `2. Contact Readwise support about book ID ${bookId} if highlights are missing\n`;
          content += `3. If highlights appear on the website, try deleting this file and re-syncing\n`;
          content += `4. This file was created as a placeholder to prevent continuous "missing item" errors\n\n`;
          content += `**Sync Attempted:** ${new Date().toISOString()}\n`;

          this.logger.info(`Creating stub file for inaccessible book ${bookId}`);
        } else {
          const highlightsData = await highlightsResponse.json();
          const highlights = highlightsData.results;

          this.logger.debug(`Fetched ${highlights.length} highlights for book ${bookId}`);

          // Add highlights
          highlights.forEach((highlight: any) => {
            content += `## ${highlight.text}\n\n`;
            if (highlight.note) {
              content += `**Note:** ${highlight.note}\n\n`;
            }
            if (highlight.tags && highlight.tags.length > 0) {
              content += `**Tags:** ${highlight.tags.map((t: any) => t.name).join(', ')}\n\n`;
            }
            content += `---\n\n`;
          });
        }

        // Save file
        const fileName = `${this.settings.readwiseDir}/${category}/${book.title}.md`;
        const finalFileName = this.resolveFilenameCollision(fileName, bookId);

        await this.createDirForFile(finalFileName);
        await this.app.vault.adapter.write(finalFileName, content);

        // Track in booksIDsMap
        this.settings.booksIDsMap[finalFileName] = bookId;

        this.logger.info(`✓ Saved book ${bookId} to ${finalFileName}`);
        results.success++;

      } catch (e) {
        this.logger.error(`Error syncing book ${bookId}:`, e);
        results.failed.push(bookId);
      }

      // Rate limiting: 20 requests per minute = 3 seconds between requests
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    await this.saveSettings();
    return results;
  }

  async configureSchedule() {
    const minutes = parseInt(this.settings.frequency);
    let milliseconds = minutes * 60 * 1000; // minutes * seconds * milliseconds
    this.logger.debug('setting interval to ', milliseconds, 'milliseconds');
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
      this.logger.info('no targetBookIds, checking for new highlights');
      // no need to hit refresh_book_export;
      // just check if there's new highlights from the server
      await this.queueExport();
      return;
    }

    this.logger.debug('refreshing books', { targetBookIds });

    let requestBookIds: string[] = [];
    let requestReaderDocumentIds: string[] = [];
    targetBookIds.map(id => {
      const readerDocumentId = this.decodeReaderDocumentId(id);
      //console.log("[Readwise-Phillip] readwise ID: ", id);
      //console.log("[Readwise-Phillip] readerDocumentId: ", readerDocumentId);
      if (readerDocumentId) {
        //console.log("[Readwise-Phillip] has readerDocumentId: ", readerDocumentId);
        requestReaderDocumentIds.push(readerDocumentId);
      } else {
        //console.log("[Readwise-Phillip] Pushing to requestBookIds: ", id);
        requestBookIds.push(id);
      }
    });

    this.logger.info(`Requesting refresh for ${requestBookIds.length} book IDs and ${requestReaderDocumentIds.length} reader document IDs`);
    this.logger.debug(`Book IDs:`, requestBookIds);
    this.logger.debug(`Reader Document IDs:`, requestReaderDocumentIds);

    // Chunk the requests to avoid 502 errors with large payloads
    const CHUNK_SIZE = 500;
    const totalItems = requestBookIds.length + requestReaderDocumentIds.length;

    // Helper function to chunk an array
    const chunkArray = <T>(array: T[], size: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
      }
      return chunks;
    };

    // Calculate how many items each type should get in each chunk
    // Distribute proportionally based on the ratio of book IDs to reader document IDs
    const bookIdChunks = chunkArray(requestBookIds, CHUNK_SIZE);
    const readerDocChunks = chunkArray(requestReaderDocumentIds, CHUNK_SIZE);
    const maxChunks = Math.max(bookIdChunks.length, readerDocChunks.length);

    this.logger.info(`Splitting request into ${maxChunks} chunk(s) of up to ${CHUNK_SIZE} items each`);

    try {
      let allSuccessful = true;

      for (let i = 0; i < maxChunks; i++) {
        const chunkBookIds = bookIdChunks[i] || [];
        const chunkReaderDocIds = readerDocChunks[i] || [];
        const chunkTotal = chunkBookIds.length + chunkReaderDocIds.length;

        this.logger.info(`Processing chunk ${i + 1}/${maxChunks} with ${chunkTotal} items (${chunkBookIds.length} book IDs, ${chunkReaderDocIds.length} reader docs)`);

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
              userBookIds: chunkBookIds,
              readerDocumentIds: chunkReaderDocIds,
            })
          }
        );

        if (response && response.ok) {
          const responseData = await response.json();
          this.logger.debug(`Chunk ${i + 1}/${maxChunks} response OK:`, responseData);
        } else {
          this.logger.warn(`Chunk ${i + 1}/${maxChunks} failed with status ${response?.status}`);
          allSuccessful = false;
        }
      }

      if (allSuccessful) {
        this.logger.info("All chunks processed successfully, proceeding to queueExport()");
        await this.queueExport();
        return;
      } else {
        this.logger.info(`Some chunks failed, saving book ids to refresh later`);
        const deduplicatedBookIds = new Set([...this.settings.booksToRefresh, ...bookIds]);
        this.settings.booksToRefresh = Array.from(deduplicatedBookIds);
        await this.saveSettings();
        return;
      }
    } catch (e) {
      this.logger.error("fetch failed in syncBookHighlights: ", e);
    }
  }

  async addToFailedBooks(bookId: string) {
    // NOTE: settings.failedBooks was added after initial settings schema,
    // so not all users may have it, hence the fallback to DEFAULT_SETTINGS.failedBooks
    let failedBooks = [...(this.settings.failedBooks || DEFAULT_SETTINGS.failedBooks)];
    failedBooks.push(bookId);
    //console.log(`[Readwise-Phillip] added book id ${bookId} to failed books`);
    this.settings.failedBooks = failedBooks;

    // don't forget to save after!
    // but don't do that here; this allows batching when removing multiple books.
  }

  async addBookToRefresh(bookId: string) {
    let booksToRefresh = [...this.settings.booksToRefresh];
    booksToRefresh.push(bookId);
    //console.log(`[Readwise-Phillip] added book id ${bookId} to refresh list`);
    this.settings.booksToRefresh = booksToRefresh;
    await this.saveSettings();
  }

  async removeBooksFromRefresh(bookIds: Array<string> = []) {
    if (!bookIds.length) return;

    this.logger.debug(`removing book ids ${bookIds.join(', ')} from refresh list`);
    this.settings.booksToRefresh = this.settings.booksToRefresh.filter(n => !bookIds.includes(n));

    // don't forget to save after!
    // but don't do that here; this allows batching when removing multiple books.
  }

  async removeBookFromFailedBooks(bookIds: Array<string> = []) {
    if (!bookIds.length) return;

    this.logger.debug(`removing book ids ${bookIds.join(', ')} from failed list`);
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
      this.logger.error("fetch failed in Reimport current file: ", e);
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

    // Initialize logger with saved log level
    this.logger = new Logger(this.settings.logLevel);

    // Load cache into memory (non-blocking)
    this.loadBooksCache().then(cache => {
      if (cache) {
        this.booksCache = cache;
        this.logger.info(`Loaded cache with ${cache.totalBooks} books`);
      }
    });

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
        this.logger.info(`Sync triggered. booksToRefresh: ${this.settings.booksToRefresh.length}, failedBooks: ${this.settings.failedBooks.length}`);
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
          this.logger.debug(`refreshBooks setting is false. booksToRefresh will not be synced.`);
          return;
        }

        this.logger.debug(`Force refreshing ${totalToRefresh} books`);
        this.logger.debug(`booksToRefresh: ${this.settings.booksToRefresh.length}`);
        this.logger.debug(`failedBooks: ${this.settings.failedBooks.length}`);
        this.logger.debug(`refreshBooks setting: ${this.settings.refreshBooks}`);

        new Notice(`Force syncing ${totalToRefresh} books from refresh queue...`, 10000);

        try {
          // Call syncBookHighlights which should trigger refresh_book_export with forceRefresh
          await this.syncBookHighlights();

          this.logger.info('Force refresh completed');
        } catch (e) {
          this.logger.error('Error during force refresh:', e);
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
          this.logger.info(`Clearing ${totalItems} items from refresh queue`);
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

        this.logger.info(diagnosticInfo);
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
            this.logger.info(`Cleared ${mdFiles.length} files from ${selectedCategory}, marked ${bookIdsToRefresh.length} books for refresh`);
          } catch (e) {
            this.logger.error('Error clearing category:', e);
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

        this.logger.info(duplicateReport);
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

        this.logger.info(collisionReport);
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
        // Check if cache is available
        if (!this.booksCache) {
          this.booksCache = await this.loadBooksCache();
        }

        let allApiBooks: any[];

        if (this.booksCache) {
          // Use cache
          const cacheAge = this.getCacheAgeDescription(this.booksCache);
          new Notice(`Using cached book data (${cacheAge}). Run "Rebuild book cache" for fresh data.`, 5000);

          // Convert cache to array format, filtering out items with 0 highlights
          allApiBooks = Object.values(this.booksCache.byId)
            .filter(book => book.num_highlights > 0)
            .map(book => ({
              id: parseInt(book.id),
              title: book.title,
              author: book.author,
              category: book.category,
              num_highlights: book.num_highlights
            }));

          this.logger.debug(`Using ${allApiBooks.length} books from cache (${cacheAge}, excluded items with 0 highlights)`);
        } else {
          // No cache - offer to build it
          new Notice('No cache found. Building cache from API (this will take a few minutes)...', 10000);
          const cache = await this.buildBooksCache(true);

          if (!cache) {
            new Notice('Failed to build cache. Please try again.', 10000);
            return;
          }

          allApiBooks = Object.values(cache.byId)
            .filter(book => book.num_highlights > 0)
            .map(book => ({
              id: parseInt(book.id),
              title: book.title,
              author: book.author,
              category: book.category,
              num_highlights: book.num_highlights
            }));
        }

        try {
          // Build set of tracked book IDs
          const trackedIds = new Set(Object.values(this.settings.booksIDsMap));
          this.logger.debug(`Currently tracking ${trackedIds.size} items locally`);

          // Find missing items
          const missingItems = allApiBooks.filter(book => {
            const bookId = book.id.toString();
            return !trackedIds.has(bookId);
          });

          this.logger.debug(`Found ${missingItems.length} missing items (items with 0 highlights excluded)`);

          // Group by category
          const categoryCounts: { [cat: string]: number } = {};
          missingItems.forEach(item => {
            const cat = item.category || 'unknown';
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
          });

          // Create report
          let report = '# Missing Items Report\n\n';
          report += `Found **${missingItems.length}** items in Readwise that are not downloaded locally.\n\n`;
          report += '**Note:** Items with 0 highlights are excluded from this report (nothing to sync).\n\n';
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

          this.logger.info(report);
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
          this.logger.error('Error finding missing items:', e);
          new Notice(`Error: ${e.message}`, 10000);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-find-missing-old',
      name: 'Find and sync missing items (old/slow)',
      callback: async () => {
        new Notice('Querying Readwise API for all items...', 10000);
        this.logger.debug('Fetching all items from API...');

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
                this.logger.warn(`Rate limited (429). Retry-After: ${waitTime/1000}s. Waiting before retry ${attempt + 1}/${maxRetries}...`);
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
              this.logger.debug(`Error on attempt ${attempt + 1}, retrying in ${waitTime/1000}s...`);
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
              this.logger.debug(`Fetched ${allApiBooks.length} items so far...`);
              new Notice(`Fetched ${allApiBooks.length} items... (page ${pageCount})`, 2000);
            }

            // Book LIST endpoint limited to 20 requests/minute = 3 seconds between requests
            if (nextUrl) { // Don't wait after the last page
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }

          this.logger.debug(`Fetched total of ${allApiBooks.length} items from API`);

          // Build set of tracked book IDs
          const trackedIds = new Set(Object.values(this.settings.booksIDsMap));
          this.logger.debug(`Currently tracking ${trackedIds.size} items locally`);

          // Find missing items
          const missingItems = allApiBooks.filter(book => {
            const bookId = book.id.toString();
            return !trackedIds.has(bookId);
          });

          this.logger.debug(`Found ${missingItems.length} missing items`);

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

          this.logger.info(report);
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
          this.logger.error('Error finding missing items:', e);
          new Notice(`Error: ${e.message}`, 10000);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-force-resync-missing',
      name: 'Force resync missing items',
      callback: async () => {
        // Check cache
        if (!this.booksCache) {
          this.booksCache = await this.loadBooksCache();
        }

        let allApiBooks: any[];

        if (this.booksCache) {
          const cacheAge = this.getCacheAgeDescription(this.booksCache);
          new Notice(`Finding missing items from cache (${cacheAge})...`, 5000);

          allApiBooks = Object.values(this.booksCache.byId)
            .filter(book => book.num_highlights > 0)
            .map(book => ({
              id: parseInt(book.id)
            }));
        } else {
          new Notice('No cache. Building from API (this takes time)...', 10000);
          const cache = await this.buildBooksCache(true);

          if (!cache) {
            new Notice('Failed to build cache', 10000);
            return;
          }

          allApiBooks = Object.values(cache.byId)
            .filter(book => book.num_highlights > 0)
            .map(book => ({
              id: parseInt(book.id)
            }));
        }

        try {
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

          this.logger.info(`Adding ${missingBookIds.length} missing items to refresh queue (items with 0 highlights excluded)`);

          // Add to booksToRefresh
          this.settings.booksToRefresh = [...new Set([...this.settings.booksToRefresh, ...missingBookIds])];
          await this.saveSettings();

          new Notice(`Added ${missingBookIds.length} missing items to sync queue. Starting sync...`, 5000);

          // Trigger sync
          await this.syncBookHighlights();

        } catch (e) {
          this.logger.error('Error resyncing missing items:', e);
          new Notice(`Error: ${e.message}`, 10000);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-direct-resync',
      name: 'Direct resync missing items (fast)',
      callback: async () => {
        // Check cache
        if (!this.booksCache) {
          this.booksCache = await this.loadBooksCache();
        }

        let allApiBooks: any[];

        if (this.booksCache) {
          const cacheAge = this.getCacheAgeDescription(this.booksCache);
          new Notice(`Finding missing items from cache (${cacheAge})...`, 5000);

          allApiBooks = Object.values(this.booksCache.byId)
            .filter(book => book.num_highlights > 0)
            .map(book => ({
              id: parseInt(book.id)
            }));
        } else {
          new Notice('No cache. Run "Rebuild book cache" first.', 10000);
          return;
        }

        try {
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

          this.logger.info(`Direct sync for ${missingBookIds.length} missing items (items with 0 highlights excluded)`);

          new Notice(`Syncing ${missingBookIds.length} items directly via API...`, 5000);

          // Use direct API instead of export system
          const results = await this.syncSpecificBooksDirect(missingBookIds);

          if (results.success > 0) {
            new Notice(`✓ Successfully synced ${results.success} items!`, 5000);
          }

          if (results.failed.length > 0) {
            new Notice(`⚠️ Failed to sync ${results.failed.length} items. Check console for details.`, 10000);
            this.logger.error(`Failed book IDs:`, results.failed);

            // Add failed items to failedBooks queue
            this.settings.failedBooks = [...new Set([...this.settings.failedBooks, ...results.failed])];
            await this.saveSettings();
          }

          // Clear booksToRefresh since we just synced them
          this.settings.booksToRefresh = [];
          await this.saveSettings();

        } catch (e) {
          this.logger.error('Error direct syncing:', e);
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

          // Check cache
          if (!this.booksCache) {
            this.booksCache = await this.loadBooksCache();
          }

          let categoryBooks: any[];

          if (this.booksCache && this.booksCache.byCategory[selectedCategory]) {
            // Use cached category index
            const cacheAge = this.getCacheAgeDescription(this.booksCache);
            new Notice(`Using cached ${categoryMap[selectedCategory]} (${cacheAge})`, 5000);

            const bookIds = this.booksCache.byCategory[selectedCategory];
            categoryBooks = bookIds
              .map(id => this.booksCache.byId[id])
              .filter(book => book && book.num_highlights > 0)
              .map(book => ({
                id: parseInt(book.id)
              }));

            this.logger.debug(`Found ${categoryBooks.length} ${selectedCategory} in cache (excluding 0 highlights)`);
          } else {
            // No cache - build it or fall back to API
            new Notice(`No cache. Building from API...`, 10000);
            const cache = await this.buildBooksCache(true);

            if (!cache || !cache.byCategory[selectedCategory]) {
              new Notice('Failed to build cache', 10000);
              return;
            }

            const bookIds = cache.byCategory[selectedCategory];
            categoryBooks = bookIds
              .map(id => cache.byId[id])
              .filter(book => book && book.num_highlights > 0)
              .map(book => ({
                id: parseInt(book.id)
              }));
          }

          try {
            // Find missing ones
            const trackedIds = new Set(Object.values(this.settings.booksIDsMap));
            const missingBookIds = categoryBooks
              .filter(book => !trackedIds.has(book.id.toString()))
              .map(book => book.id.toString());

            if (missingBookIds.length === 0) {
              new Notice(`All ${categoryMap[selectedCategory]} are already synced!`, 5000);
              return;
            }

            this.logger.info(`Found ${missingBookIds.length} missing ${selectedCategory} (items with 0 highlights excluded)`);

            // Add to refresh queue and sync
            this.settings.booksToRefresh = [...new Set([...this.settings.booksToRefresh, ...missingBookIds])];
            await this.saveSettings();

            new Notice(`Syncing ${missingBookIds.length} missing ${categoryMap[selectedCategory]}...`, 5000);
            await this.syncBookHighlights();

          } catch (e) {
            this.logger.error(`Error syncing ${selectedCategory}:`, e);
            new Notice(`Error: ${e.message}`, 10000);
          }
        };

        modal.open();
      }
    });
    this.addCommand({
      id: 'readwise-official-rebuild-cache',
      name: 'Rebuild book cache',
      callback: async () => {
        const cache = await this.buildBooksCache(true);
        if (cache) {
          new Notice(`Cache rebuilt: ${cache.totalBooks} books`, 5000);
        }
      }
    });
    this.addCommand({
      id: 'readwise-official-clear-cache',
      name: 'Clear book cache',
      callback: async () => {
        await this.clearBooksCache();
        new Notice('Book cache cleared', 5000);
      }
    });
    this.addCommand({
      id: 'readwise-official-cache-stats',
      name: 'View cache statistics',
      callback: async () => {
        if (!this.booksCache) {
          this.booksCache = await this.loadBooksCache();
        }

        if (!this.booksCache) {
          new Notice('No cache available. Run "Rebuild book cache" first.', 5000);
          return;
        }

        const cache = this.booksCache;
        const cacheAge = this.getCacheAgeDescription(cache);
        const isStale = this.isCacheStale(cache);

        let stats = '# Book Cache Statistics\n\n';
        stats += `**Last updated:** ${cache.lastUpdated} (${cacheAge})\n`;
        stats += `**Status:** ${isStale ? '⚠️ Stale (>7 days)' : '✓ Fresh'}\n`;
        stats += `**Total books:** ${cache.totalBooks}\n\n`;
        stats += '## By Category\n';
        stats += `- Articles: ${cache.byCategory.articles?.length || 0}\n`;
        stats += `- Books: ${cache.byCategory.books?.length || 0}\n`;
        stats += `- Tweets: ${cache.byCategory.tweets?.length || 0}\n`;
        stats += `- Podcasts: ${cache.byCategory.podcasts?.length || 0}\n\n`;
        stats += '## Actions\n';
        stats += '- Run "Rebuild book cache" to refresh data from API\n';
        stats += '- Run "Clear book cache" to delete cache file\n';

        const reportFile = `${this.settings.readwiseDir}/Cache-Stats-${Date.now()}.md`;
        await this.app.vault.create(reportFile, stats);
        const file = this.app.vault.getAbstractFileByPath(reportFile);
        if (file) {
          // @ts-ignore
          await this.app.workspace.getLeaf().openFile(file);
        }

        new Notice('Cache statistics generated', 5000);
      }
    });
    this.addCommand({
      id: 'readwise-official-detect-collisions',
      name: 'Detect filename collisions',
      callback: async () => {
        if (!this.booksCache) {
          this.booksCache = await this.loadBooksCache();
        }

        if (!this.booksCache) {
          new Notice('No cache available. Run "Rebuild book cache" first.', 5000);
          return;
        }

        new Notice('Analyzing filename collisions...', 5000);

        // Build map of titles to book IDs
        const titleToBooks: { [title: string]: Array<{ id: string, category: string, tracked: boolean }> } = {};

        Object.values(this.booksCache.byId).forEach(book => {
          if (book.num_highlights === 0) return; // Skip 0-highlight items

          const title = book.title.trim();
          if (!titleToBooks[title]) {
            titleToBooks[title] = [];
          }

          const isTracked = Object.values(this.settings.booksIDsMap).includes(book.id);
          titleToBooks[title].push({
            id: book.id,
            category: book.category,
            tracked: isTracked
          });
        });

        // Find titles with duplicates
        const collisions = Object.entries(titleToBooks)
          .filter(([_, books]) => books.length > 1)
          .sort((a, b) => b[1].length - a[1].length);

        // Generate report
        let report = '# Filename Collision Report\n\n';
        report += `**Generated:** ${new Date().toISOString()}\n\n`;
        report += `**Total titles with collisions:** ${collisions.length}\n`;
        report += `**Total duplicate items:** ${collisions.reduce((sum, [_, books]) => sum + books.length, 0)}\n\n`;

        report += '## Summary\n\n';
        report += 'This report identifies items with duplicate titles that map to the same filename.\n';
        report += 'Items marked with ✗ are NOT tracked in booksIDsMap (lost due to collision).\n';
        report += 'Items marked with ✓ ARE tracked (but may contain merged content from duplicates).\n\n';

        // Count by impact
        const withMissing = collisions.filter(([_, books]) => books.some(b => !b.tracked));
        const allTracked = collisions.filter(([_, books]) => books.every(b => b.tracked));

        report += `**Collisions with lost tracking:** ${withMissing.length}\n`;
        report += `**Collisions where all items tracked:** ${allTracked.length} (files may contain merged content)\n\n`;

        report += '## Collisions with Lost Tracking\n\n';
        report += 'These collisions have items that are NOT tracked in booksIDsMap:\n\n';

        withMissing.forEach(([title, books]) => {
          report += `### ${title}\n\n`;
          books.forEach(book => {
            const status = book.tracked ? '✓' : '✗';
            report += `- ${status} **${book.category}** - ID: \`${book.id}\`${book.tracked ? '' : ' ⚠️ NOT TRACKED'}\n`;
          });
          report += '\n';
        });

        if (allTracked.length > 0) {
          report += '## Collisions with All Items Tracked\n\n';
          report += 'These items all appear tracked, but files may contain merged content from multiple sources:\n\n';

          allTracked.slice(0, 20).forEach(([title, books]) => {
            report += `### ${title}\n\n`;
            books.forEach(book => {
              report += `- ✓ **${book.category}** - ID: \`${book.id}\`\n`;
            });
            report += '\n';
          });

          if (allTracked.length > 20) {
            report += `... and ${allTracked.length - 20} more\n\n`;
          }
        }

        report += '## Recommended Actions\n\n';
        report += '1. **Review collisions** - Identify which items you want to keep\n';
        report += '2. **Delete collision files** - Remove files with duplicate titles from your vault\n';
        report += '3. **Resync** - Run "Force resync missing items" to download with unique filenames\n';
        report += '4. The plugin will now append book IDs to prevent future collisions\n';

        const reportFile = `${this.settings.readwiseDir}/Collision-Report-${Date.now()}.md`;
        await this.app.vault.create(reportFile, report);
        const file = this.app.vault.getAbstractFileByPath(reportFile);
        if (file) {
          // @ts-ignore
          await this.app.workspace.getLeaf().openFile(file);
        }

        new Notice(`Found ${collisions.length} filename collisions. Report created.`, 5000);
      }
    });
    this.addCommand({
      id: 'readwise-official-fix-collisions',
      name: 'Fix filename collisions (delete and resync)',
      callback: async () => {
        if (!this.booksCache) {
          this.booksCache = await this.loadBooksCache();
        }

        if (!this.booksCache) {
          new Notice('No cache available. Run "Rebuild book cache" first.', 5000);
          return;
        }

        new Notice('Analyzing collisions...', 3000);

        // Build map of titles to book IDs (same logic as detect command)
        const titleToBooks: { [title: string]: Array<{ id: string, category: string, title: string }> } = {};

        Object.values(this.booksCache.byId).forEach(book => {
          if (book.num_highlights === 0) return;

          const title = book.title.trim();
          if (!titleToBooks[title]) {
            titleToBooks[title] = [];
          }

          const isTracked = Object.values(this.settings.booksIDsMap).includes(book.id);
          titleToBooks[title].push({
            id: book.id,
            category: book.category,
            title: book.title
          });
        });

        // Find titles with duplicates
        const collisions = Object.entries(titleToBooks)
          .filter(([_, books]) => books.length > 1);

        if (collisions.length === 0) {
          new Notice('No collisions found!', 5000);
          return;
        }

        // Find all files that correspond to collision titles
        const filesToDelete: string[] = [];
        const bookIDsToResync: string[] = [];

        for (const [title, books] of collisions) {
          // For each collision, we need to find the corresponding file(s)
          for (const book of books) {
            // Build the expected filename for this book
            const categoryFolder = book.category.charAt(0).toUpperCase() + book.category.slice(1);
            const expectedFilename = `${this.settings.readwiseDir}/${categoryFolder}/${title}.md`;

            // Check if this file exists in booksIDsMap
            const trackedBookID = this.settings.booksIDsMap[expectedFilename];

            if (trackedBookID) {
              // This file exists - mark it for deletion
              if (!filesToDelete.includes(expectedFilename)) {
                filesToDelete.push(expectedFilename);
              }
            }

            // Add all book IDs from this collision to resync list
            if (!bookIDsToResync.includes(book.id)) {
              bookIDsToResync.push(book.id);
            }
          }
        }

        // Show confirmation modal
        const modal = new Modal(this.app);
        modal.titleEl.setText("Fix Filename Collisions");

        modal.contentEl.createEl('p', {
          text: `Found ${collisions.length} filename collisions involving ${bookIDsToResync.length} items.`
        });

        modal.contentEl.createEl('p', {
          text: `This will:`
        });

        const list = modal.contentEl.createEl('ul');
        list.createEl('li', { text: `Delete ${filesToDelete.length} collision files from your vault` });
        list.createEl('li', { text: `Remove ${filesToDelete.length} entries from booksIDsMap` });
        list.createEl('li', { text: `Queue ${bookIDsToResync.length} book IDs for resync` });
        list.createEl('li', { text: `Files will be recreated with unique names (appending ID if needed)` });

        modal.contentEl.createEl('p', {
          text: '⚠️ This action cannot be undone. Make sure you have a backup!'
        });

        const buttonsContainer = modal.contentEl.createEl('div', { cls: "rw-modal-btns" });
        const cancelBtn = buttonsContainer.createEl("button", { text: "Cancel" });
        const confirmBtn = buttonsContainer.createEl("button", { text: "Delete and Resync" });

        cancelBtn.onclick = () => modal.close();
        confirmBtn.onclick = async () => {
          modal.close();
          new Notice('Deleting collision files...', 5000);

          let deletedCount = 0;
          let errorCount = 0;

          // Delete files
          for (const filePath of filesToDelete) {
            try {
              const fileExists = await this.app.vault.adapter.exists(filePath);
              if (fileExists) {
                await this.app.vault.adapter.remove(filePath);
                deletedCount++;
                this.logger.info(`Deleted collision file: ${filePath}`);
              }

              // Remove from booksIDsMap
              delete this.settings.booksIDsMap[filePath];
            } catch (e) {
              this.logger.error(`Error deleting ${filePath}:`, e);
              errorCount++;
            }
          }

          // Save settings
          await this.saveSettings();

          new Notice(`Deleted ${deletedCount} files. Queueing ${bookIDsToResync.length} items for resync...`, 5000);

          // Add all collision book IDs to refresh queue
          this.settings.booksToRefresh = [...new Set([...this.settings.booksToRefresh, ...bookIDsToResync])];
          await this.saveSettings();

          if (errorCount > 0) {
            new Notice(`⚠️ ${errorCount} files failed to delete. Check console for details.`, 10000);
          }

          new Notice(`Ready to resync! Run "Force resync missing items" to download with unique filenames.`, 10000);
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
        // Clean up sync state if isSyncing flag was set but no sync ID present
        if (this.settings.isSyncing) {
          this.logger.debug("Clearing stale isSyncing flag on layout ready");
          this.settings.isSyncing = false;
          await this.saveSettings();
        }
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
    // Update logger level when settings change
    if (this.logger) {
      this.logger.setLogLevel(this.settings.logLevel);
    }
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
      this.logger.error("fetch failed in getUserAuthToken: ", e);
    }
    if (response && response.ok) {
      data = await response.json();
    } else {
      this.logger.error("bad response in getUserAuthToken: ", response);
      this.showInfoStatus(button.parentElement, "Authorization failed. Try again", "rw-error");
      return;
    }
    if (data.userAccessToken) {
      this.logger.info("successfully authenticated with Readwise");
      this.settings.token = data.userAccessToken;
      await this.saveSettings();
    } else {
      if (attempt > 20) {
        this.logger.warn('reached attempt limit in getUserAuthToken');
        return;
      }
      this.logger.debug(`didn't get token data, retrying (attempt ${attempt + 1})`);
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
                this.logger.warn("Readwise sync already in progress");
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

      new Setting(containerEl)
        .setName('Log level')
        .setDesc('Control console logging verbosity: ERROR (only errors), WARN (warnings + errors, default), INFO (status updates), DEBUG (all details)')
        .addDropdown(dropdown => {
          dropdown.addOption(LogLevel.ERROR.toString(), "Error");
          dropdown.addOption(LogLevel.WARN.toString(), "Warning");
          dropdown.addOption(LogLevel.INFO.toString(), "Info");
          dropdown.addOption(LogLevel.DEBUG.toString(), "Debug");
          dropdown.setValue(this.plugin.settings.logLevel.toString());
          dropdown.onChange(async (newValue) => {
            this.plugin.settings.logLevel = parseInt(newValue) as LogLevel;
            await this.plugin.saveSettings();
          });
        });

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
