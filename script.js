'use strict';

(() => {
  /**
   * Configuration for HTML selectors, API URL, and other settings
   * @type {Object}
   */
  const config = {
    selectors: {
      novelContainer: 'h3',
      novelName: 'a',
      pdfLink: 'a',
      imageContainer: 'p',
      coverImage: 'img',
      coverImageSrc: ['src'],
    },
    apiUrl: 'https://jnovels.com/top-light-novels-to-read/',
    placeholderImage: 'https://via.placeholder.com/500x700?text=No+Image',
    initialPageSize: 30, // Initial number of novels to load
    dynamicPageSize: 20, // Page size for dynamic loading based on scroll speed
    debounceDelay: 300,
    retry: {
      maxAttempts: 7,
      initialDelay: 1500,
    },
    fetchTimeout: 15000,
    dataValidityDuration: 7 * 24 * 60 * 60 * 1000, // 7 days
    AOS: {
      duration: 700,
      easing: 'ease-in-out',
      once: true,
      mirror: false,
      offset: 50,
    },
    imageFileExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'], // Common image file extensions
  };

  /**
   * Generate a random database name
   * @returns {string}
   */
  const generateDbName = () => `MonochromeNovelsDB_${Math.random().toString(36).substring(2, 15)}`;

  let dbName = generateDbName();
  let db = initializeDatabase(dbName);

   /**
   * Initialize Dexie Database with Compound Index
   * @param {string} dbName
   * @returns {Dexie}
   */
  function initializeDatabase(dbName) {
    const dbInstance = new Dexie(dbName);
    dbInstance.version(36).stores({
      // Add compound index for better query performance
      novels: '++id, &[name+coverUrl+pdfUrl], timestamp', 
      settings: '++id, &key, value'
    });

    dbInstance.on('blocked', () => {
      console.warn('Database blocked. User might have the site open in another tab.');
      notifyUser('Database access blocked. Please close other tabs or windows with this site open.', 'warning');
    });

    dbInstance.on('versionchange', () => {
      console.warn('Database version change detected. Closing database.');
      dbInstance.close();
      notifyUser('Database updated. Please refresh the page.', 'info');
    });

    dbInstance.open().catch(err => {
      console.error(`Failed to open database: ${err.stack || err}`);
      notifyUser('Failed to open database. Please try refreshing the page or clearing browser data.', 'error');
    });

    return dbInstance;
  }

  // State variables
  let currentPage = 0;
  let isLoading = false;
  let hasMore = true;
  let currentSearchTerm = '';
  let totalNovels = 0;
  let loadedNovels = 0;

  // Scrolling Management
  let lastScrollTime = 0;
  let scrollSpeeds = [];
  const SCROLL_SPEED_SAMPLES = 5;
  const SCROLL_SPEED_ADJUSTMENT_INTERVAL = 500;

  // Network status
  let isOnline = navigator.onLine;

  /**
   * Debounce Function
   */
  const debounce = (func, delay) => {
    let debounceTimer;
    return function (...args) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => func.apply(this, args), delay);
    };
  };

  /**
   * Asynchronous Delay Function
   */
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Retry Operation with Exponential Backoff
   */
  const retryOperation = async (operation, maxAttempts = config.retry.maxAttempts, initialDelay = config.retry.initialDelay) => {
    let attempt = 0;
    while (attempt < maxAttempts) {
      try {
        return await operation();
      } catch (error) {
        attempt++;
        const delayDuration = initialDelay * Math.pow(2, attempt - 1);
        console.warn(`Attempt ${attempt} failed. Retrying in ${delayDuration / 1000} seconds...`);
        if (attempt === maxAttempts) {
          throw new Error(`Operation failed after ${maxAttempts} attempts: ${error.message}`);
        }
        await delay(delayDuration);
      }
    }
  };

  /**
   * Initialize Intersection Observer for Infinite Scroll and Lazy Loading
   */
  const setupSentinelObserver = () => {
    const sentinel = document.getElementById('sentinel');
    if (!sentinel) return;

    const handleIntersect = (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && hasMore && !isLoading) {
          loadNextPage();
        }
      });
    };

    if (!('IntersectionObserver' in window)) {
      const lazyLoad = () => {
        if (hasMore && !isLoading) {
          const scrollPosition = window.scrollY || window.pageYOffset;
          const windowHeight = window.innerHeight;
          const documentHeight = document.documentElement.scrollHeight;

          if (scrollPosition + windowHeight >= documentHeight - 500) {
            loadNextPage();
          }
        }
        lazyLoadImages();
      };

      window.addEventListener('scroll', lazyLoad);
      window.addEventListener('resize', lazyLoad);
      window.addEventListener('orientationchange', lazyLoad);
      return;
    }

    const sentinelObserver = new IntersectionObserver(handleIntersect, {
      rootMargin: '200px',
      threshold: 0.1
    });

    sentinelObserver.observe(sentinel);

    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const lazyImage = entry.target;
          const placeholder = lazyImage.nextElementSibling;
          lazyImage.src = lazyImage.dataset.src;

          lazyImage.onload = () => {
            lazyImage.classList.add('loaded');
            placeholder.classList.add('hide-placeholder');
          };

          lazyImage.onerror = () => {
            lazyImage.src = config.placeholderImage;
            lazyImage.classList.add('loaded');
            placeholder.classList.add('hide-placeholder');
          };

          observer.unobserve(lazyImage);
        }
      });
    }, {
      threshold: 0.1
    });

    // Observe images dynamically as they are added to the DOM
    const content = document.getElementById('content');
    if (content) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const images = node.querySelectorAll('.card__image');
                images.forEach(image => {
                  imageObserver.observe(image);
                });
              }
            });
          }
        });
      });

      observer.observe(content, { childList: true, subtree: true });
    }
  };

  /**
   * Adjusts the page size dynamically based on the user's scrolling speed.
   */
  const adjustPageSize = () => {
    if (scrollSpeeds.length === 0) return;

    const avgScrollSpeed = scrollSpeeds.reduce((sum, speed) => sum + speed, 0) / scrollSpeeds.length;

    if (avgScrollSpeed > 1000) {
      config.dynamicPageSize = 10;
    } else if (avgScrollSpeed > 500) {
      config.dynamicPageSize = 15;
    } else {
      config.dynamicPageSize = 20;
    }
  };

  /**
   * Load Next Page of Novels
   */
  const loadNextPage = async () => {
    if (!isOnline) {
      notifyUser('You are offline. Please check your internet connection.', 'warning');
      return;
    }
    if (isLoading || !hasMore) return;
    isLoading = true;
    showLoader();

    try {
      let novels;
      const isInitialLoad = currentPage === 0;
      const pageSize = isInitialLoad ? config.initialPageSize : config.dynamicPageSize;
      const start = isInitialLoad ? 0 : config.initialPageSize + (currentPage - 1) * config.dynamicPageSize;

      if (currentSearchTerm === '') {
        novels = await db.novels
          .orderBy('name')
          .offset(start)
          .limit(pageSize)
          .toArray();
      } else {
        novels = await db.novels
          .where('name')
          .startsWithIgnoreCase(currentSearchTerm)
          .offset(start)
          .limit(pageSize)
          .toArray();
      }

      if (novels.length > 0) {
        appendNovelsToDisplay(novels);
        currentPage++;
        hasMore = novels.length === pageSize;
      } else {
        hasMore = false;
        if (!isInitialLoad) {
          notifyUser('No more novels found.', 'info');
        } else if (currentSearchTerm !== '') {
          notifyUser('No novels found for the given search term.', 'info');
        }
      }
    } catch (error) {
      console.error('Error loading novels:', error);
      notifyUser('An error occurred while loading novels.', 'error');
    } finally {
      hideLoader();
      isLoading = false;
    }
  };

  /**
   * Show Loader
   */
  const showLoader = () => {
    const loader = document.getElementById('loader');
    if (loader) {
      loader.style.opacity = '0';
      loader.style.display = 'block';
      setTimeout(() => loader.style.opacity = '1', 10);
    }
  };

  /**
   * Hide Loader
   */
  const hideLoader = () => {
    const loader = document.getElementById('loader');
    if (loader) {
      loader.style.opacity = '0';
      setTimeout(() => loader.style.display = 'none', 300);
    }
  };

  /**
   * Display a Non-Intrusive Notification to the User
   */
  const notifyUser = (message, type = 'info', duration = 5000) => {
    const notificationContainer = document.getElementById('notification-container');
    if (!notificationContainer) return;

    const notification = document.createElement('div');
    notification.classList.add('notification', `notification--${type}`);
    notification.textContent = message;
    notification.setAttribute('role', 'alert');

    notificationContainer.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('notification--show');
    }, 10);

    setTimeout(() => {
      notification.classList.remove('notification--show');
      setTimeout(() => {
        notification.remove();
      }, 300);
    }, duration);
  };

  /**
   * Append Novels to Display with Optimized Rendering and Image Handling
   * @param {Array} novels - The array of novel objects
   */
  const appendNovelsToDisplay = (novels) => {
    const content = document.getElementById('content');
    if (!content) return;

    const fragment = document.createDocumentFragment();
    novels.forEach((novel) => {
      const card = createNovelCard(novel);
      fragment.appendChild(card);
    });

    requestAnimationFrame(() => {
      content.appendChild(fragment);
      AOS.refresh();
      // Removed lazyLoadImages from here as it's handled by MutationObserver
    });
  };

  /**
   * Lazy load images that are currently in the viewport
   */
  const lazyLoadImages = () => {
    const images = document.querySelectorAll('.card__image');
    images.forEach(image => {
      if (isInViewport(image)) {
        const placeholder = image.nextElementSibling;
        image.src = image.dataset.src;

        image.onload = () => {
          image.classList.add('loaded');
          placeholder.classList.add('hide-placeholder');
        };

        image.onerror = () => {
          image.src = config.placeholderImage;
          image.classList.add('loaded');
          placeholder.classList.add('hide-placeholder');
        };
      }
    });
  };

  /**
   * Check if an element is in the viewport
   * @param {HTMLElement} element
   * @returns {boolean}
   */
  const isInViewport = (element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  };

  /**
   * Create Novel Card Element with Image Placeholder
   * @param {Object} novel - The novel object
   * @returns {HTMLElement} - The novel card element
   */
  const createNovelCard = (novel) => {
    const card = document.createElement('div');
    card.classList.add('card');
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-labelledby', `novel-title-${encodeURIComponent(novel.name)}`);
    card.setAttribute('data-aos', 'fade-up');

    const imageContainer = document.createElement('div');
    imageContainer.classList.add('card__image-container');

    const image = document.createElement('img');
    image.classList.add('card__image');
    // Use placeholder initially; the real image will be loaded by IntersectionObserver
    image.src = config.placeholderImage;
    image.dataset.src = novel.coverUrl || config.placeholderImage; 
    image.alt = `Cover of ${novel.name}`;
    image.setAttribute('loading', 'lazy');
    // Placeholder for loading state
    const placeholder = document.createElement('div');
    placeholder.classList.add('card__image-placeholder');
    placeholder.textContent = 'Loading...'; // Or use a spinner

    imageContainer.appendChild(image);
    imageContainer.appendChild(placeholder);
    card.appendChild(imageContainer);

    const content = document.createElement('div');
    content.classList.add('card__content');

    const title = document.createElement('h2');
    title.id = `novel-title-${encodeURIComponent(novel.name)}`;
    title.classList.add('card__title');
    title.textContent = novel.name;
    content.appendChild(title);
    card.appendChild(content);

    card.addEventListener('click', () => showModal(novel));
    card.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        showModal(novel);
      }
    });

    return card;
  };

  /**
   * Sanitize HTML to Prevent XSS Vulnerabilities
   */
  const sanitizeHTML = (str) => {
    return DOMPurify.sanitize(str);
  };

  /**
   * Modal Functionality
   */
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modal-title');
  const modalLink = document.getElementById('modal-link');
  const closeBtn = document.querySelector('.close');

  /**
   * Show Modal with Novel Details
   */
  const showModal = (novel) => {
    if (!modal || !modalTitle || !modalLink) return;

    modalTitle.textContent = novel.name;
    modalLink.href = novel.pdfUrl;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    closeBtn.focus();
  };

  /**
   * Close Modal and Restore Focus
   */
  const closeModal = () => {
    if (!modal) return;

    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = 'auto';

    const triggeringElement = document.activeElement;
    if (triggeringElement) {
      triggeringElement.focus();
    }
  };

  if (closeBtn) {
    closeBtn.addEventListener('click', closeModal);
  }

  window.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && modal.classList.contains('show')) {
      closeModal();
    }
  });

  /**
   * Search Functionality with Debouncing
   */
  const searchInput = document.getElementById('search-input');
  const handleSearch = debounce(async () => {
    currentSearchTerm = sanitizeHTML(searchInput.value.trim());
    currentPage = 0;
    hasMore = true;
    const content = document.getElementById('content');
    if (content) {
      content.innerHTML = '';
    }
    await loadNextPage();
  }, config.debounceDelay);

  if (searchInput) {
    searchInput.addEventListener('input', handleSearch);
  }

  /**
   * Refresh Data Functionality
   */
  const refreshButton = document.getElementById('refresh-button');
  if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
      const confirmation = confirm('Are you sure you want to refresh the data? This may take a few moments.');
      if (!confirmation) return;

      isLoading = true;
      showLoader();
      hasMore = true;
      currentPage = 0;
      refreshButton.disabled = true;

      try {
        db.close();
        await Dexie.delete(dbName);

        dbName = generateDbName();
        db = initializeDatabase(dbName);

        await fetchAndStoreNovels();

        const content = document.getElementById('content');
        if (content) {
          content.innerHTML = '';
        }
        await loadNextPage();

        notifyUser('Data refreshed successfully!', 'success');
      } catch (error) {
        console.error('Error refreshing data:', error);
        notifyUser('Failed to refresh data. Please try again later.', 'error');
      } finally {
        hideLoader();
        isLoading = false;
        refreshButton.disabled = false;
      }
    });
  }

  /**
   * Initialize Application
   */
  const initializeApp = async () => {
    try {
      const count = await db.novels.count();
      if (count === 0 || !(await isDataValid())) {
        if (isOnline) {
          await fetchAndStoreNovels();
        } else {
          notifyUser('You are offline and no data is cached. Please connect to the internet to load data.', 'warning');
          return;
        }
      }
      await loadNextPage();
    } catch (error) {
      console.error('Error initializing application:', error);
      notifyUser('Failed to load novels. Please try refreshing the page.', 'error');
    }
  };

  /**
   * Check if the Stored Data is Valid
   */
  const isDataValid = async () => {
    try {
      const novels = await db.novels.limit(1).toArray();
      if (novels.length === 0) return false;

      const novel = novels[0];
      if (!novel.name || !novel.coverUrl || !novel.pdfUrl || !novel.timestamp) {
        return false;
      }

      const oneWeekAgo = Date.now() - config.dataValidityDuration;
      return novel.timestamp > oneWeekAgo;
    } catch (error) {
      console.error('Error validating data:', error);
      return false;
    }
  };

  /**
   * Fetch and Store Novels with Improved Uniqueness Check and Image Handling
   */
  const fetchAndStoreNovels = async () => {
    try {
      const html = await retryOperation(() => fetchHTML(config.apiUrl));
      let novels = parseHTML(html);

      if (!novels || novels.length === 0) {
        throw new Error('No novels found on the target page.');
      }

      totalNovels = novels.length;
      loadedNovels = 0;
      showProgress();
      updateProgress(0);

      const content = document.getElementById('content');

      const chunkSize = 50;
      for (let i = 0; i < novels.length; i += chunkSize) {
        const chunk = novels.slice(i, i + chunkSize);
        await db.transaction('rw', db.novels, async () => {
          for (const novel of chunk) {
            try {
              // Use the compound index for a more efficient uniqueness check
              const existingNovel = await db.novels.where({
                name: novel.name,
                coverUrl: novel.coverUrl,
                pdfUrl: novel.pdfUrl
              }).first();

              if (!existingNovel) {
                await db.novels.put({
                  name: sanitizeHTML(novel.name),
                  coverUrl: sanitizeHTML(novel.coverUrl),
                  pdfUrl: sanitizeHTML(novel.pdfUrl),
                  timestamp: Date.now()
                });
                loadedNovels++;
                updateProgress((loadedNovels / totalNovels) * 100);

                if (content) {
                  const card = createNovelCard(novel);
                  requestAnimationFrame(() => {
                    content.appendChild(card);
                    AOS.refresh();
                    // Lazy loading is handled by IntersectionObserver now
                  });
                }
              } else {
                console.warn('Skipping duplicate novel:', novel.name);
              }
            } catch (error) {
              console.warn(`Error adding novel to database (skipping): ${novel.name} - ${error}`);
            }
          }
        });
      }

      console.log('Novels fetched and stored successfully:', loadedNovels);
      notifyUser('Novels fetched and stored successfully.', 'success');
      clearFetchedHTML();
    } catch (error) {
      console.error('Error fetching or storing novels:', error);
      notifyUser('Failed to fetch and store novels. Please try again later.', 'error');
    } finally {
      hideProgress();
    }
  };


  /**
   * Fetch HTML Content
   */
  const fetchHTML = async (url) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.fetchTimeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-cache',
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const htmlContent = await response.text();

      if (!htmlContent || typeof htmlContent !== 'string') {
        throw new Error('Fetched content is invalid or empty.');
      }

      return htmlContent;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('Fetch request timed out.');
        notifyUser('Failed to fetch data due to timeout. Please check your network connection and try again.', 'error');
      } else {
        console.error('Error fetching HTML:', error);
        notifyUser('Failed to fetch data. Please check your network connection and try again.', 'error');
      }
      throw error;
    }
  };

  /**
   * Parse Fetched HTML with Improved Image URL Handling and Error Handling
   */
  const parseHTML = (html) => {
    const purifiedHTML = DOMPurify.sanitize(html, {
      FORBID_TAGS: ['style', 'script'],
      FORBID_ATTR: ['style', 'onerror', 'onload'],
    });

    const parser = new DOMParser();
    const doc = parser.parseFromString(purifiedHTML, 'text/html');
    const novels = [];

    const novelContainers = doc.querySelectorAll(config.selectors.novelContainer);
    novelContainers.forEach((container) => {
      try {
        const nameElement = container.querySelector(config.selectors.novelName);
        const pdfLinkElement = container.querySelector(config.selectors.pdfLink);

        if (!nameElement || !pdfLinkElement) {
          console.warn(`Missing <${config.selectors.novelName}> or <${config.selectors.pdfLink}> tag within <${config.selectors.novelContainer}>. Skipping this entry.`);
          return;
        }

        const name = nameElement.textContent.trim();
        const pdfLink = pdfLinkElement.getAttribute('href').trim();
        const imageContainer = container.nextElementSibling?.tagName === config.selectors.imageContainer.toUpperCase()
          ? container.nextElementSibling
          : null;

        let coverUrl = '';
        if (imageContainer) {
          const imgElement = imageContainer.querySelector(config.selectors.coverImage);
          if (imgElement) {
            let src = imgElement.getAttribute(config.selectors.coverImageSrc[0]).trim();

            // Find the index of the first occurrence of any valid extension
            let extensionIndex = -1;
            for (const ext of config.imageFileExtensions) {
              const index = src.indexOf(ext);
              if (index !== -1) {
                extensionIndex = index + ext.length; // Add extension length to include it
                break;
              }
            }

            // Extract the URL up to the end of the valid extension
            if (extensionIndex !== -1) {
              coverUrl = src.substring(0, extensionIndex);
            } else {
              console.warn(`Image URL does not have a recognized image extension: ${src}`);
            }
          }
        }

        // Constructing absolute URLs
        if (coverUrl.startsWith('//')) {
          coverUrl = `https:${coverUrl}`;
        } else if (coverUrl.startsWith('/')) {
          coverUrl = `https://jnovels.com${coverUrl}`;
        } else if (coverUrl && !coverUrl.startsWith('http')) {
          coverUrl = `https://jnovels.com/${coverUrl}`;
        }

        // Handle incomplete data more gracefully
        if (name && pdfLink) {
          novels.push({
            name,
            coverUrl,
            pdfUrl: pdfLink,
          });
        } else {
          console.warn('Incomplete novel data found:', { name, pdfLink, coverUrl }); // Log incomplete data
        }
      } catch (error) {
        console.error('Error parsing a novel entry:', error);
      }
    });
    return novels;
  };

  /**
   * Clear Fetched HTML Content
   */
  const clearFetchedHTML = () => {
    // Placeholder
    console.log('Clearing fetched HTML content...');
  };

  /**
   * Clear Cache
   */
  const clearCache = () => {
    caches.keys().then(cacheNames => {
      cacheNames.forEach(cacheName => {
        if (cacheName !== dbName) {
          caches.delete(cacheName);
        }
      });
    });
  };
  window.addEventListener('beforeunload', clearCache);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearCache();
    }
  });

  /**
   * Update Progress Bar
   */
  const updateProgress = (percentage) => {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    if (progressBar) {
      progressBar.style.width = `0%`;
      setTimeout(() => progressBar.style.width = `${percentage}%`, 10);
    }
    if (progressText) {
      progressText.textContent = `${Math.round(percentage)}%`;
    }
  };

  /**
   * Show Progress Bar and Text
   */
  const showProgress = () => {
    const progressContainer = document.getElementById('progress-container');
    const progressTextElement = document.getElementById('progress-text');
    if (progressContainer) {
      progressContainer.style.display = 'block';
    }
    if (progressTextElement) {
      progressTextElement.style.display = 'block';
    }
  };

  /**
   * Hide Progress Bar and Text
   */
  const hideProgress = () => {
    const progressContainer = document.getElementById('progress-container');
    const progressTextElement = document.getElementById('progress-text');
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
    if (progressTextElement) {
      progressTextElement.style.display = 'none';
    }
  };

  /**
   * Handle Online/Offline Events
   */
  const handleOnlineStatus = () => {
    isOnline = navigator.onLine;
    if (isOnline) {
      notifyUser('You are back online!', 'success');
      if (hasMore && !isLoading) {
        loadNextPage();
      }
    } else {
      notifyUser('You are offline. Some features may be unavailable.', 'warning');
    }
  };
  window.addEventListener('online', handleOnlineStatus);
  window.addEventListener('offline', handleOnlineStatus);

  /**
   * Initialize Theme Toggle
   */
  const initializeTheme = async () => {
    const themeToggle = document.getElementById('theme-toggle');
    if (!themeToggle) return;

    try {
      const themeSetting = await db.settings.get({ key: 'theme' });
      const currentTheme = themeSetting ? themeSetting.value : 'dark';

      document.body.setAttribute('data-theme', currentTheme);
      themeToggle.checked = currentTheme === 'light';
      themeToggle.setAttribute('aria-label', `Toggle theme. Currently set to ${currentTheme}`);

      themeToggle.addEventListener('change', async () => {
        const newTheme = themeToggle.checked ? 'light' : 'dark';
        document.body.setAttribute('data-theme', newTheme);
        await db.settings.put({ key: 'theme', value: newTheme });
        themeToggle.setAttribute('aria-label', `Toggle theme. Currently set to ${newTheme}`);
      });
    } catch (error) {
      console.error('Error initializing theme:', error);
    }
  };

  /**
   * Initialize Menu Button and Menu
   */
  const initializeMenu = () => {
    const menuButton = document.getElementById('menu-button');
    const menu = document.getElementById('menu');
    const settingsPanel = document.getElementById('settings-panel');
    const settingsPanelClose = document.querySelector('.settings-panel__close');

    if (menuButton) {
      menuButton.addEventListener('click', () => {
        if (menu) {
          menu.classList.toggle('open');
          document.body.style.overflow = menu.classList.contains('open') ? 'hidden' : 'auto';
          if (menu.classList.contains('open')) {
            const firstFocusableElement = menu.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (firstFocusableElement) {
              firstFocusableElement.focus();
            }
          }
        }
      });
    }

    if (menu) {
      const menuItems = menu.querySelectorAll('.menu__item');
      menuItems.forEach((item) => {
        item.addEventListener('click', (e) => {
          const target = e.target.getAttribute('data-target');
          if (target === 'home') {
            currentSearchTerm = '';
            currentPage = 0;
            hasMore = true;
            const content = document.getElementById('content');
            if (content) {
              content.innerHTML = '';
            }
            loadNextPage();
          } else if (target === 'settings' && settingsPanel) {
            settingsPanel.classList.add('open');
            document.body.style.overflow = 'hidden';
            if (settingsPanelClose) {
              settingsPanelClose.focus();
            }
          }
          if (menu) {
            menu.classList.remove('open');
          }
          document.body.style.overflow = 'auto';
        });
      });
    }

    if (settingsPanelClose) {
      settingsPanelClose.addEventListener('click', () => {
        if (settingsPanel) {
          settingsPanel.classList.remove('open');
          document.body.style.overflow = 'auto';
        }
      });
    }

    window.addEventListener('click', (event) => {
      if (event.target === settingsPanel && settingsPanel.classList.contains('open')) {
        settingsPanel.classList.remove('open');
        document.body.style.overflow = 'auto';
      }
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && settingsPanel && settingsPanel.classList.contains('open')) {
        settingsPanel.classList.remove('open');
        document.body.style.overflow = 'auto';
      }
    });
  };

  /**
   * Records the user's scrolling speed.
   */
  const recordScrollSpeed = () => {
    const now = Date.now();
    const timeSinceLastScroll = now - lastScrollTime;
    lastScrollTime = now;

    const scrollSpeed = timeSinceLastScroll > 0 ? 1000 / timeSinceLastScroll : 0;

    scrollSpeeds.push(scrollSpeed);
    if (scrollSpeeds.length > SCROLL_SPEED_SAMPLES) {
      scrollSpeeds.shift();
    }

    adjustPageSize();
  };

  /**
   * Initializes scroll speed monitoring.
   */
  const initializeScrollMonitoring = () => {
    window.addEventListener('scroll', () => {
      recordScrollSpeed();
    });
    setInterval(adjustPageSize, SCROLL_SPEED_ADJUSTMENT_INTERVAL);
  };

  /**
   * Initialize AOS, Scroll Monitoring and Start the Application
   */
  document.addEventListener('DOMContentLoaded', () => {
    AOS.init(config.AOS);
    handleOnlineStatus();
    setupSentinelObserver();
    initializeApp();
    initializeTheme();
    initializeMenu();
    initializeScrollMonitoring();
  });
})();
