   * @param {number} page
   * @param {number} pageSize
   * @returns {Promise<Array<Object>>}
   */
  const getNovelsByPage = async (page, pageSize) => {
    return new Promise((resolve, reject) => {
      const store = db.getStore('novels');
      const novels = [];
      const request = store.index('name').openCursor(null, 'next');

      const offset = page * pageSize;
      let skipped = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          if (skipped < offset) {
            skipped++;
            cursor.continue();
          } else if (novels.length < pageSize) {
            novels.push(cursor.value);
            cursor.continue();
          } else {
            resolve(novels);
          }
        } else {
          resolve(novels);
        }
      };

      request.onerror = () => reject(request.error);
    });
  };

  /**
   * Search Novels by Name
   * @param {string} searchTerm
   * @param {number} page
   * @param {number} pageSize
   * @returns {Promise<Array<Object>>}
   */
  const searchNovels = async (searchTerm, page, pageSize) => {
    searchTerm = searchTerm.toLowerCase();
    return new Promise((resolve, reject) => {
      const store = db.getStore('novels');
      const novels = [];
      const request = store.index('name').openCursor();

      const offset = page * pageSize;
      let skipped = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          const name = cursor.value.name.toLowerCase();
          if (name.includes(searchTerm)) {
            if (skipped < offset) {
              skipped++;
            } else if (novels.length < pageSize) {
              novels.push(cursor.value);
            } else {
              resolve(novels);
            }
          }
          cursor.continue();
        } else {
          resolve(novels);
        }
      };

      request.onerror = () => reject(request.error);
    });
  };

  /**
   * Utility: Escape HTML to Prevent XSS
   * @param {string} str
   * @returns {string}
   */
  const escapeHTML = (str) => {
    if (!str) return '';
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
  };

  /**
   * Toast Notification Functionality
   */
  // Repeated function removed to prevent duplication

  /**
   * Initialize Theme Toggle Sync
   */
  // Already handled in initializeTheme to avoid duplication

  /**
   * Clear Fetched HTML Content
   */
  const clearFetchedHTML = () => {
    // Placeholder for any cleanup if necessary
    console.log('Clearing fetched HTML content...');
  };

  /**
   * Utility: Hide Progress if not already hidden
   */
  const hideProgressSafely = () => {
    if (document.getElementById('progress-container').style.display !== 'none') {
      hideProgress();
    }
  };
});
