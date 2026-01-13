#!/bin/bash

# Readwise Plugin Recovery Script
# This script helps recover from stuck/incomplete Readwise syncs

PLUGIN_DIR="/Users/phillip/Library/Mobile Documents/com~apple~CloudDocs/PARA/.obsidian/plugins/readwise-official"
DATA_FILE="$PLUGIN_DIR/data.json"
BACKUP_DIR="$PLUGIN_DIR/backups"

echo "=== Readwise Plugin Recovery Tool ==="
echo ""

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Function to backup current state
backup_data() {
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_DIR/data_backup_$timestamp.json"
    cp "$DATA_FILE" "$backup_file"
    echo "✓ Backed up current state to: $backup_file"
}

# Function to show current state
show_state() {
    echo "Current Plugin State:"
    echo "-------------------"
    jq '{
        lastSavedStatusID,
        currentSyncStatusID,
        isSyncing,
        lastSyncFailed,
        refreshBooks,
        booksToRefresh: (.booksToRefresh | length),
        failedBooks: (.failedBooks | length),
        totalTrackedBooks: (.booksIDsMap | length)
    }' "$DATA_FILE"
    echo ""
}

# Function to reset sync state
reset_sync_state() {
    echo "Resetting sync state (will force fresh export on next sync)..."
    backup_data

    # Use jq to modify the JSON
    jq '.lastSavedStatusID = 0 | .currentSyncStatusID = 0 | .isSyncing = false | .lastSyncFailed = false' "$DATA_FILE" > "$DATA_FILE.tmp"
    mv "$DATA_FILE.tmp" "$DATA_FILE"

    echo "✓ Sync state reset. Next sync will request a fresh export from Readwise."
    echo "⚠️  You must restart Obsidian for changes to take effect!"
}

# Function to count files in Readwise directory
count_files() {
    local readwise_dir=$(jq -r '.readwiseDir' "$DATA_FILE")
    local full_path="/Users/phillip/Library/Mobile Documents/com~apple~CloudDocs/PARA/$readwise_dir"

    if [ -d "$full_path" ]; then
        local book_count=$(find "$full_path/Books" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
        local article_count=$(find "$full_path/Articles" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
        local total=$((book_count + article_count))

        echo "Files in Readwise directory:"
        echo "  Books: $book_count"
        echo "  Articles: $article_count"
        echo "  Total: $total"
    else
        echo "⚠️  Readwise directory not found: $full_path"
    fi
}

# Main menu
while true; do
    echo ""
    echo "Choose an option:"
    echo "1) Show current state"
    echo "2) Count files in Readwise directory"
    echo "3) Reset sync state (force fresh export)"
    echo "4) Create backup of current data.json"
    echo "5) Exit"
    echo ""
    read -p "Enter choice [1-5]: " choice

    case $choice in
        1)
            show_state
            ;;
        2)
            count_files
            ;;
        3)
            echo ""
            read -p "This will force a fresh export. Continue? (y/N): " confirm
            if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
                reset_sync_state
            else
                echo "Cancelled."
            fi
            ;;
        4)
            backup_data
            ;;
        5)
            echo "Exiting."
            exit 0
            ;;
        *)
            echo "Invalid choice. Please try again."
            ;;
    esac
done
