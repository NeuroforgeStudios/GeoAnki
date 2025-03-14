// ==UserScript==
// @name         GeoGuessr Anki Integration 
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Automatically creates Anki flashcards after each GeoGuessr round with improved round detection, location accuracy, and instant add feature
// @author       GeoGuessr-Anki-Dev (Enhanced)
// @match        https://*.geoguessr.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      nominatim.openstreetmap.org
// @connect      restcountries.com
// @connect      flagcdn.com
// @connect      api.geoguessr.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /* ========= UTILITY FUNCTIONS ========= */
    // Debug mode configuration
    const DEBUG = {
        enabled: true,
        logs: [],
        maxLogs: 100,

        log: function(message, data = null) {
            if (!this.enabled) return;

            const timestamp = new Date().toISOString();
            const entry = {
                time: timestamp,
                level: 'INFO',
                message: message,
                data: data ? JSON.stringify(data) : null
            };
            console.log(`[GeoAnki INFO] ${message}`, data || '');
            this.logs.push(entry);
            this.trimLogs();
        },

        error: function(message, error = null) {
            const timestamp = new Date().toISOString();
            const entry = {
                time: timestamp,
                level: 'ERROR',
                message: message,
                error: error ? (error.stack || error.toString()) : null
            };
            console.error(`[GeoAnki ERROR] ${message}`, error || '');
            this.logs.push(entry);
            this.trimLogs();
        },

        warn: function(message, data = null) {
            if (!this.enabled) return;

            const timestamp = new Date().toISOString();
            const entry = {
                time: timestamp,
                level: 'WARN',
                message: message,
                data: data ? JSON.stringify(data) : null
            };
            console.warn(`[GeoAnki WARN] ${message}`, data || '');
            this.logs.push(entry);
            this.trimLogs();
        },

        trimLogs: function() {
            if (this.logs.length > this.maxLogs) {
                this.logs = this.logs.slice(-this.maxLogs);
            }
        },

        getLogs: function() {
            return this.logs;
        },

        exportLogs: function() {
            return JSON.stringify(this.logs, null, 2);
        },

        copyLogsToClipboard: function() {
            const logsText = this.exportLogs();
            navigator.clipboard.writeText(logsText)
                .then(() => {
                    showNotification('Debug logs copied to clipboard', 'success');
                })
                .catch(err => {
                    console.error('Failed to copy logs:', err);
                    showNotification('Failed to copy logs', 'error');
                });
        }
    };

    // Debounce function to limit frequency of function calls
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    // Safe DOM selection with multiple fallback selectors
    function safeQuerySelector(selectors, parent = document) {
        if (typeof selectors === 'string') selectors = [selectors];

        for (const selector of selectors) {
            try {
                const element = parent.querySelector(selector);
                if (element) return element;
            } catch (e) {
                DEBUG.warn(`Invalid selector: ${selector}`, e);
            }
        }
        return null;
    }

    // Safe API call with timeout and error handling
    function safeApiCall(url, options = {}, timeout = 5000) {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                DEBUG.warn(`API call to ${url} timed out`);
                resolve(null);
            }, timeout);

            fetch(url, options)
                .then(response => {
                    clearTimeout(timeoutId);
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    return response.json();
                })
                .then(data => {
                    resolve(data);
                })
                .catch(error => {
                    clearTimeout(timeoutId);
                    DEBUG.error(`API call to ${url} failed:`, error);
                    resolve(null);
                });
        });
    }

    // Enhanced GM_xmlhttpRequest with better error handling
    function safeGmXhr(options) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                DEBUG.warn(`GM_xmlhttpRequest to ${options.url} timed out`);
                reject(new Error('Request timed out'));
            }, options.timeout || 10000);

            GM_xmlhttpRequest({
                ...options,
                onload: (response) => {
                    clearTimeout(timeout);
                    try {
                        const result = JSON.parse(response.responseText);
                        resolve(result);
                    } catch (e) {
                        DEBUG.error('Error parsing response:', e);
                        reject(e);
                    }
                },
                onerror: (error) => {
                    clearTimeout(timeout);
                    DEBUG.error('Request error:', error);
                    reject(error);
                },
                ontimeout: () => {
                    clearTimeout(timeout);
                    DEBUG.error('Request timed out');
                    reject(new Error('Request timed out'));
                }
            });
        });
    }

    // Validate and sanitize coordinates
    function sanitizeCoordinates(lat, lng) {
        lat = parseFloat(lat);
        lng = parseFloat(lng);

        if (isNaN(lat) || isNaN(lng)) {
            return null;
        }

        // Clamp to valid ranges
        lat = Math.max(-90, Math.min(90, lat));
        lng = Math.max(-180, Math.min(180, lng));

        return { lat, lng };
    }

    // Load settings with defaults
    const settings = GM_getValue('geoguessr_anki_settings', {
        uiScale: 1.0,
        uiOpacity: 0.9,
        enableAnkiIntegration: true,
        ankiConnectPort: 8765,
        ankiDefaultDeck: "GeoguessrAnki",
        modelName: "GeoguessrBasic",
        showUIButton: true,
        automaticCards: true,
        hideLocationInFrontCard: true,
        instantAddEnabled: GM_getValue('instantAddEnabled', false) // New setting for instant add
    });

    const ANKI_CONNECT_URL = "http://localhost:" + settings.ankiConnectPort;
    const DECK_NAME = settings.ankiDefaultDeck;
    const MODEL_NAME = settings.modelName;

    /* ========= STATE MANAGEMENT ========= */
    let gameState = {
        inGame: false,
        inRound: false,
        roundNumber: 0,
        roundStartTime: null,
        gameType: null,
        currentLocation: null,
        panoId: null,
        heading: 0,
        pitch: 0,
        zoom: 0,
        guessLocation: null,
        guessCountry: null,
        actualLocation: null,
        actualCountry: null,
        score: 0,
        maxScore: 5000,
        countryData: null,
        guessCountryData: null,
        userGuess: null,
        missedClues: [],
        locationOverview: null,
        // Properties to store user's reflections
        userMissedClues: "",
        userReminder: "",
        // Add round-specific data storage
        roundLocations: {},
        currentRoundKey: null,
        cardCreatedForRound: false,
        // For improved round transition detection
        lastUrl: window.location.href,
        lastRoundId: null,
        isProcessingRound: false,
        cancelCardCreation: false,
        // For data source tracking
        dataSource: null
    };

    // Store timeouts and intervals for cleanup
    window.geoAnkiTimeouts = [];
    window.geoAnkiIntervals = [];

    /* ========= COUNTRY OVERRIDE DATABASE ========= */
    // Add known problematic coordinates and their correct countries
    const COUNTRY_OVERRIDES = [
        {
            // This handles the Australia/Guatemala case from the debug logs
            coordinates: { lat: 40.97989806962013, lng: -67.5 },
            tolerance: 0.2, // Tolerance for coordinate matching
            country: "Guatemala",
            countryCode: "GT",
            additionalInfo: {
                tld: ".gt",
                drivingSide: "right",
                languages: ["Spanish"],
                currency: "Guatemalan quetzal",
                continent: "North America",
                capital: "Guatemala City"
            }
        }
    ];

    // Function to check if coordinates match any known override
    function checkCountryOverride(lat, lng) {
        for (const override of COUNTRY_OVERRIDES) {
            const tolerance = override.tolerance || 0.1;
            if (Math.abs(lat - override.coordinates.lat) <= tolerance && 
                Math.abs(lng - override.coordinates.lng) <= tolerance) {
                DEBUG.log(`Country override match found! ${lat},${lng} → ${override.country}`);
                return override;
            }
        }
        return null;
    }

    /* ========= CORE UTILITY FUNCTIONS ========= */
    function isGeoGuessr() {
        return window.location.hostname.includes('geoguessr.com');
    }

    function isInGame() {
        return window.location.href.includes('/game/') ||
               window.location.href.includes('/challenge/') ||
               window.location.href.includes('/duel/') ||
               window.location.href.includes('/battle-royale/');
    }

    // More robust round end detection
    function isRoundEnded() {
        // Check for any result screen elements that appear when a round ends
        const resultElements = document.querySelectorAll(
            'div[data-qa="round-result"], ' +
            '.result-layout_content, ' +
            '.round-result_wrapper__, ' +
            '[class*="result-layout"], ' +
            '[class*="results"], ' +
            '[class*="summary-"], ' +
            'div[class*="result"]'
        );

        if (resultElements.length > 0) {
            for (const el of resultElements) {
                // Make sure it's visible
                if (el.offsetParent !== null) {
                    return true;
                }
            }
        }

        // Also check for round result button
        const nextRoundButton = document.querySelector(
            'button[data-qa="close-round-result"], ' +
            '[class*="next-round"]'
        );

        if (nextRoundButton && nextRoundButton.offsetParent !== null) {
            return true;
        }

        return false;
    }

    // Better active round detection
    function isInActiveRound() {
        if (!isInGame()) return false;

        // If we can see a result screen, we're not in an active round
        if (isRoundEnded()) return false;

        // Check for elements that only appear during active gameplay
        const gameplayElements = document.querySelectorAll(
            'div[data-qa="game-status"], ' +
            '[class*="game-status"], ' +
            '[class*="compass"], ' +
            '[data-qa="timer"]'
        );

        for (const el of gameplayElements) {
            if (el.offsetParent !== null) {
                return true;
            }
        }

        return false;
    }

    // Better between rounds detection
    function isBetweenRounds() {
        return isInGame() && isRoundEnded();
    }

    function getCurrentRoundNumber() {
        if (!isInGame()) return 0;

        // Try multiple selectors to find round number
        const matchGame = window.location.href.match(/\/game\/[^\/]+\/round\/(\d+)/);
        if (matchGame && matchGame[1]) return parseInt(matchGame[1], 10);

        const roundIndicator = safeQuerySelector('div[data-qa="round-number"]');
        if (roundIndicator) {
            const roundText = roundIndicator.textContent.trim();
            const match = roundText.match(/(\d+)\s*\/\s*\d+/);
            if (match && match[1]) return parseInt(match[1], 10);
        }

        const roundEl = safeQuerySelector('[class^=round-score_roundNumber__]');
        if (roundEl) {
            const text = roundEl.innerText;
            const match = text.match(/(\d+)/);
            if (match) return parseInt(match[1], 10);
        }

        return isInGame() ? 1 : 0;
    }

    function getGameType() {
        if (!isInGame()) return null;
        if (window.location.href.includes('/battle-royale/')) return 'battle-royale';
        if (window.location.href.includes('/duel/')) return 'duel';
        if (window.location.href.includes('/challenge/')) return 'challenge';
        return 'standard';
    }

    // Generate a unique round key for storing location data
    function generateRoundKey() {
        const gameId = window.location.href.split('/')[4] || 'unknown';
        const roundNum = getCurrentRoundNumber();
        return `${gameId}-round-${roundNum}`;
    }

    // Extract round ID from URL or DOM
    function extractRoundId() {
        // Try to get round ID from URL
        const urlMatch = window.location.pathname.match(/\/round\/(\d+)/);
        if (urlMatch && urlMatch[1]) {
            return 'url-' + urlMatch[1];
        }

        // Try to get round ID from DOM
        const roundElement = document.querySelector('[data-qa="round-number"]');
        if (roundElement) {
            const text = roundElement.textContent;
            const match = text.match(/(\d+)\s*\/\s*\d+/);
            if (match && match[1]) {
                return 'dom-' + match[1];
            }
        }

        return null;
    }

    // Safely decode panoId with validation
    function panoIdDecoder(geoguessrPanoId) {
        if (!geoguessrPanoId) return "";

        // Validate it's a hex string
        if (!/^[0-9a-fA-F]+$/.test(geoguessrPanoId)) {
            DEBUG.warn("Invalid panoId format:", geoguessrPanoId);
            return "";
        }

        try {
            let gsvPanoId = "";
            for (let i = 0; i < geoguessrPanoId.length; i+=2) {
                if (i + 1 >= geoguessrPanoId.length) break; // Avoid odd-length strings
                let seq = geoguessrPanoId.substring(i, i+2);
                gsvPanoId += String.fromCharCode(parseInt(seq, 16));
            }
            return gsvPanoId;
        } catch (e) {
            DEBUG.error("Error decoding panoId:", e);
            return "";
        }
    }

    // Create Google Maps Street View link with sanitized inputs
    function createStreetViewLink(lat, lng, panoId, heading = 0, pitch = 0, zoom = 1) {
        // Sanitize coordinates
        const coords = sanitizeCoordinates(lat, lng);
        if (!coords) {
            DEBUG.warn("Invalid coordinates:", lat, lng);
            return "#";
        }

        // Sanitize numeric parameters
        heading = parseFloat(heading) || 0;
        pitch = parseFloat(pitch) || 0;
        zoom = parseFloat(zoom) || 1;

        // Clamp values to valid ranges
        heading = ((heading % 360) + 360) % 360; // Normalize to 0-359
        pitch = Math.max(-90, Math.min(90, pitch)); // -90 to 90
        zoom = Math.max(0, Math.min(4, zoom)); // 0 to 4

        if (!panoId) {
            // Simple link without panoId
            return `https://www.google.com/maps/@${coords.lat.toFixed(6)},${coords.lng.toFixed(6)},3a,90y,0h,0t/data=!3m1!1e1`;
        }

        const pid = panoIdDecoder(panoId);
        if (!pid) {
            return `https://www.google.com/maps/@${coords.lat.toFixed(6)},${coords.lng.toFixed(6)},3a,90y,0h,0t/data=!3m1!1e1`;
        }

        const h = Math.round(heading * 100) / 100;
        const p = Math.round((90 + pitch) * 100) / 100;
        const z = Math.round((90 - zoom/2.75*90) * 10) / 10;

        return `https://www.google.com/maps/@${coords.lat.toFixed(6)},${coords.lng.toFixed(6)},3a,${z}y,${h}h,${p}t/data=!3m6!1e1!3m4!1s${encodeURIComponent(pid)}!2e0!7i13312!8i6656`;
    }

    function isValidCoordinate(coord) {
        return coord &&
               typeof coord.lat === 'number' && !isNaN(coord.lat) &&
               typeof coord.lng === 'number' && !isNaN(coord.lng) &&
               Math.abs(coord.lat) <= 90 && Math.abs(coord.lng) <= 180;
    }

    /* ========= DATA INTERCEPTION & ROUND DETECTION ========= */
    // Setup URL change detection for SPA navigation
    function setupUrlChangeDetection() {
        // Create a MutationObserver to watch for DOM changes (for round transitions)
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    // Check for newly added elements that indicate a round transition
                    const hasImportantChange = Array.from(mutation.addedNodes).some(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check for timer, round indicator, or other elements that appear on round start
                            return node.querySelector('[data-qa="round-number"]') ||
                                  node.querySelector('[data-qa="timer"]') ||
                                  node.querySelector('[class*="guess-map_"]') ||
                                  node.querySelector('[data-qa="round-result"]');
                        }
                        return false;
                    });

                    if (hasImportantChange) {
                        DEBUG.log('Detected DOM change that might indicate a round transition');
                        checkForRoundTransition();
                    }
                }
            }
        });

        // Start observing the body with all its child nodes
        observer.observe(document.body, { childList: true, subtree: true });

        // Also check for URL changes (using a polling approach)
        setInterval(() => {
            const currentUrl = window.location.href;
            if (currentUrl !== gameState.lastUrl) {
                DEBUG.log('URL changed from', gameState.lastUrl, 'to', currentUrl);
                gameState.lastUrl = currentUrl;
                checkForRoundTransition();
            }
        }, 500);
    }

    function checkForRoundTransition() {
        // Get the current round ID (can be from URL or DOM)
        const currentRoundId = extractRoundId();

        if (currentRoundId && currentRoundId !== gameState.lastRoundId) {
            DEBUG.log('New round detected:', currentRoundId);
            gameState.lastRoundId = currentRoundId;

            // Reset location data for the new round
            resetRoundData();

            // Force re-detection of game state
            gameLoop(true);

            // Try to get location data for the new round
            setTimeout(() => {
                interceptLocationData();
            }, 500);
        }

        // Also check for round end state changes
        const roundEnded = isRoundEnded();
        if (roundEnded && !gameState.isProcessingRound && gameState.inRound) {
            DEBUG.log('Round end detected');
            gameState.isProcessingRound = true;
            
            // Handle round end with a slight delay to ensure data is ready
            setTimeout(() => {
                handleRoundEnd();
                gameState.isProcessingRound = false;
            }, 1000);
        }
    }

    function resetRoundData() {
        DEBUG.log('Resetting round data');
        
        // Keep old round data in roundLocations, but reset current state
        gameState.currentLocation = null;
        gameState.panoId = null;
        gameState.heading = 0;
        gameState.pitch = 0;
        gameState.zoom = 0;
        gameState.guessLocation = null;
        gameState.guessCountry = null;
        gameState.actualLocation = null;
        gameState.actualCountry = null;
        gameState.score = 0;
        gameState.countryData = null;
        gameState.guessCountryData = null;
        gameState.missedClues = [];
        gameState.locationOverview = null;
        gameState.userMissedClues = "";
        gameState.userReminder = "";
        gameState.cardCreatedForRound = false;
        gameState.dataSource = null;
        gameState.cancelCardCreation = false;
    }

    // Comprehensive location data interception
    function interceptLocationData() {
        DEBUG.log('Intercepting location data from multiple sources');
        
        // Try all sources
        interceptNextData();
        interceptApiData();
        extractLocationFromDOM();
        
        // Watch for Google Maps to load if not already available
        if (!window.google || !window.google.maps) {
            watchForGoogleMaps();
        } else if (!gameState.dataSource) {
            interceptStreetView();
        }
    }

    // Setup XHR interception to capture game data with error handling
    function setupXHRInterception() {
        DEBUG.log("Setting up XHR interception");
        const originalXHROpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            this.addEventListener('load', function() {
                try {
                    // For Google Maps metadata - extract panoId and other data
                    if (url && url.includes('google.internal.maps.mapsjs')) {
                        processGoogleMapsResponse(this.responseText);
                    }

                    // For GeoGuessr API - extract game data
                    if (url && (url.includes('geoguessr.com/api/v3/games') || 
                               url.includes('geoguessr.com/api/v4/games') ||
                               url.includes('api/v3/challenges'))) {
                        processGeoGuessrApiResponse(this.responseText, url);
                    }
                } catch (e) {
                    DEBUG.error("XHR Interception error", e);
                }
            });
            return originalXHROpen.apply(this, arguments);
        };

        DEBUG.log("XHR Interception set up successfully");
    }

    // Intercept fetch requests
    function interceptFetch() {
        const originalFetch = window.fetch;
        window.fetch = function(resource, init) {
            if (typeof resource === 'string' &&
                (resource.includes('api/v3/games') ||
                 resource.includes('api/v4/games') ||
                 resource.includes('api/v3/challenges'))) {

                DEBUG.log('Fetch intercepted API call:', resource);
            }

            return originalFetch.apply(this, arguments).then(response => {
                // We'll only clone and examine API responses
                if (typeof resource === 'string' &&
                    (resource.includes('api/v3/games') ||
                     resource.includes('api/v4/games') ||
                     resource.includes('api/v3/challenges'))) {

                    // Clone the response so we can read it and still return the original
                    const clone = response.clone();

                    // Process the cloned response
                    clone.json().then(data => {
                        processGeoGuessrApiResponse(data, resource);
                    }).catch(err => {
                        DEBUG.error('Error processing fetch response:', err);
                    });
                }

                return response;
            });
        };

        DEBUG.log("Fetch interception set up");
    }

    // Extract data from Next.js
    function interceptNextData() {
        try {
            const nextDataElement = document.getElementById('__NEXT_DATA__');
            if (!nextDataElement) {
                DEBUG.log('Next.js data element not found');
                return false;
            }

            DEBUG.log('Found Next.js data element');

            const rawData = nextDataElement.textContent;
            const data = JSON.parse(rawData);

            // Extract rounds data if available
            if (data?.props?.pageProps?.game?.rounds) {
                const rounds = data.props.pageProps.game.rounds;
                DEBUG.log('Found rounds data in Next.js. Rounds:', rounds.length);

                if (rounds.length > 0) {
                    // Try to get the current round based on round number
                    const currentRound = gameState.roundNumber > 0 && gameState.roundNumber <= rounds.length ?
                                        gameState.roundNumber - 1 : // Use the correct index based on round number
                                        rounds.length - 1; // Otherwise use the last round as fallback

                    const round = rounds[currentRound];

                    if (round && round.lat && round.lng) {
                        DEBUG.log('Found location in Next.js data for round', currentRound + 1, ':', round.lat, round.lng);

                        // Generate round key if not already set
                        if (!gameState.currentRoundKey) {
                            gameState.currentRoundKey = generateRoundKey();
                        }

                        // Initialize round data if needed
                        if (!gameState.roundLocations[gameState.currentRoundKey]) {
                            gameState.roundLocations[gameState.currentRoundKey] = {
                                panoId: round.panoId || null,
                                location: { lat: round.lat, lng: round.lng },
                                heading: round.heading || 0,
                                pitch: round.pitch || 0,
                                zoom: round.zoom || 0,
                                country: null,
                                countryData: null
                            };
                        } else {
                            // Update location in existing round data
                            gameState.roundLocations[gameState.currentRoundKey].location = { lat: round.lat, lng: round.lng };
                            if (round.panoId) gameState.roundLocations[gameState.currentRoundKey].panoId = round.panoId;
                            if (round.heading) gameState.roundLocations[gameState.currentRoundKey].heading = round.heading;
                            if (round.pitch) gameState.roundLocations[gameState.currentRoundKey].pitch = round.pitch;
                            if (round.zoom) gameState.roundLocations[gameState.currentRoundKey].zoom = round.zoom;
                        }

                        // Update current state
                        gameState.actualLocation = { lat: round.lat, lng: round.lng };
                        gameState.currentLocation = { lat: round.lat, lng: round.lng };
                        if (round.panoId) gameState.panoId = round.panoId;
                        if (round.heading) gameState.heading = round.heading;
                        if (round.pitch) gameState.pitch = round.pitch;
                        if (round.zoom) gameState.zoom = round.zoom;
                        gameState.dataSource = 'nextjs';

                        // Check for country override based on coordinates
                        const override = checkCountryOverride(round.lat, round.lng);
                        if (override) {
                            processCountryOverride(override);
                        } else if (round.countryCode) {
                            // If we have a country code, use it
                            gameState.countryCode = round.countryCode;
                            getCountryInfo(round.countryCode);
                        } else {
                            // Otherwise try to get country from coordinates
                            getCountryFromCoordinates(round.lat, round.lng);
                        }

                        return true;
                    }
                }
            }

            DEBUG.log('No useful location data found in Next.js data');
            return false;
        } catch (e) {
            DEBUG.error('Error extracting Next.js data:', e);
            return false;
        }
    }

    // Extract location data from GeoGuessr API responses
    function interceptApiData() {
        // Try to get the game token from URL
        const urlMatch = window.location.href.match(/\/game\/([^\/]+)/);
        if (!urlMatch || !urlMatch[1]) {
            DEBUG.log('Could not extract game token from URL');
            return;
        }

        const gameToken = urlMatch[1];
        const currentRound = getCurrentRoundNumber();
        
        // Attempt to fetch data from the API
        const apiUrl = `https://www.geoguessr.com/api/v3/games/${gameToken}`;
        
        fetch(apiUrl)
            .then(response => response.json())
            .then(data => {
                processGeoGuessrApiResponse(data, apiUrl);
            })
            .catch(error => {
                DEBUG.error('Error fetching API data:', error);
            });
    }

    // Process Google Maps API responses
    function processGoogleMapsResponse(responseText) {
        DEBUG.log(`Processing Google Maps API response`);

        try {
            // Generate a round key if we don't have one yet
            if (!gameState.currentRoundKey && isInActiveRound()) {
                gameState.currentRoundKey = generateRoundKey();
                DEBUG.log(`Generated new round key: ${gameState.currentRoundKey}`);

                // Initialize round data storage if needed
                if (!gameState.roundLocations[gameState.currentRoundKey]) {
                    gameState.roundLocations[gameState.currentRoundKey] = {
                        panoId: null,
                        location: null,
                        heading: 0,
                        pitch: 0,
                        zoom: 0,
                        country: null,
                        countryData: null
                    };
                }
            }

            // Look for panoId patterns
            const panoIdMatch = responseText.match(/"panoId":"([^"]+)"/);
            if (panoIdMatch && panoIdMatch[1]) {
                const panoId = panoIdMatch[1];

                // Store in round-specific storage if we have a valid round key
                if (gameState.currentRoundKey) {
                    gameState.roundLocations[gameState.currentRoundKey].panoId = panoId;
                }

                // Also update current state
                gameState.panoId = panoId;
                DEBUG.log("PanoID captured:", panoId);
            }

            // Extract coordinates pattern
            const coordsPattern = /-?\d+\.\d+,-?\d+\.\d+/g;
            const coordsMatch = responseText.match(coordsPattern);
            if (coordsMatch && coordsMatch[0]) {
                const coords = coordsMatch[0].split(",");
                const lat = parseFloat(coords[0]);
                const lng = parseFloat(coords[1]);

                if (!isNaN(lat) && !isNaN(lng)) {
                    DEBUG.log(`Intercepted coordinates from Google Maps: ${lat}, ${lng}`);

                    // Check for country override based on coordinates
                    const override = checkCountryOverride(lat, lng);
                    if (override) {
                        processCountryOverride(override);
                    }

                    // Validate coordinates
                    const validCoords = sanitizeCoordinates(lat, lng);
                    if (validCoords) {
                        // Store in round-specific storage
                        if (gameState.currentRoundKey) {
                            gameState.roundLocations[gameState.currentRoundKey].location = validCoords;
                        }

                        // Also update current state
                        gameState.currentLocation = validCoords;
                        gameState.actualLocation = validCoords;
                        gameState.dataSource = 'googlemaps';

                        // If no override found, use Nominatim to get country info
                        if (!override && isInActiveRound() && (!gameState.countryData || !gameState.actualCountry)) {
                            getCountryFromCoordinates(validCoords.lat, validCoords.lng);
                        }
                    }
                }
            }

            // Extract heading, pitch, zoom if available
            const headingMatch = responseText.match(/"heading":([0-9.-]+)/);
            if (headingMatch && headingMatch[1]) {
                const heading = parseFloat(headingMatch[1]);

                // Store in round-specific storage
                if (gameState.currentRoundKey) {
                    gameState.roundLocations[gameState.currentRoundKey].heading = heading;
                }

                // Also update current state
                gameState.heading = heading;
            }

            const pitchMatch = responseText.match(/"pitch":([0-9.-]+)/);
            if (pitchMatch && pitchMatch[1]) {
                const pitch = parseFloat(pitchMatch[1]);

                // Store in round-specific storage
                if (gameState.currentRoundKey) {
                    gameState.roundLocations[gameState.currentRoundKey].pitch = pitch;
                }

                // Also update current state
                gameState.pitch = pitch;
            }

            const zoomMatch = responseText.match(/"zoom":([0-9.-]+)/);
            if (zoomMatch && zoomMatch[1]) {
                const zoom = parseFloat(zoomMatch[1]);

                // Store in round-specific storage
                if (gameState.currentRoundKey) {
                    gameState.roundLocations[gameState.currentRoundKey].zoom = zoom;
                }

                // Also update current state
                gameState.zoom = zoom;
            }
        } catch (e) {
            DEBUG.error("Error processing Google Maps response", e);
        }
    }

    // Process GeoGuessr API responses
    function processGeoGuessrApiResponse(data, url) {
        DEBUG.log(`Processing GeoGuessr API response from ${url}`);

        try {
            if (!data || !data.rounds) {
                DEBUG.warn("Invalid GeoGuessr API response - missing rounds");
                return;
            }

            // Store game data for later use
            if (!gameState.gameData) {
                gameState.gameData = data;
                DEBUG.log("Stored game data", data);
            }

            // If this is round result, extract guess data
            if (isRoundEnded() && data.player && data.player.guesses) {
                DEBUG.log("Round ended, extracting guess data");
                const currentRound = getCurrentRoundNumber() - 1; // 0-indexed

                if (!data.player.guesses[currentRound]) {
                    DEBUG.warn(`No guess data for round ${currentRound+1}`);
                    return;
                }

                const guess = data.player.guesses[currentRound];

                // Make sure we have the correct round key
                const roundKey = generateRoundKey();
                gameState.currentRoundKey = roundKey;

                // Initialize round data if needed
                if (!gameState.roundLocations[roundKey]) {
                    gameState.roundLocations[roundKey] = {
                        panoId: null,
                        location: null,
                        heading: 0,
                        pitch: 0,
                        zoom: 0,
                        country: null,
                        countryData: null,
                        guessLocation: null,
                        guessCountry: null,
                        guessCountryData: null,
                        score: 0
                    };
                }

                // Validate coordinates before storing
                const guessCoords = sanitizeCoordinates(guess.lat, guess.lng);
                if (guessCoords) {
                    // Store in round-specific storage
                    gameState.roundLocations[roundKey].guessLocation = guessCoords;

                    // Also update current state
                    gameState.guessLocation = guessCoords;
                    DEBUG.log("Guess location", gameState.guessLocation);

                    // Get the actual location
                    if (data.rounds && data.rounds[currentRound]) {
                        const actualLocation = data.rounds[currentRound];
                        const actualCoords = sanitizeCoordinates(actualLocation.lat, actualLocation.lng);

                        if (actualCoords) {
                            // Check for country override based on coordinates
                            const override = checkCountryOverride(actualCoords.lat, actualCoords.lng);
                            if (override) {
                                processCountryOverride(override, roundKey);
                            }
                            
                            // Store actual location in round-specific storage
                            gameState.roundLocations[roundKey].location = actualCoords;

                            // Also update current state if needed
                            gameState.actualLocation = actualCoords;
                            gameState.currentLocation = actualCoords;
                            gameState.dataSource = 'api';
                            DEBUG.log("Actual location from API", gameState.actualLocation);

                            // Store panoId if available
                            if (actualLocation.panoId) {
                                gameState.roundLocations[roundKey].panoId = actualLocation.panoId;
                                gameState.panoId = actualLocation.panoId;
                            }

                            // Store heading, pitch, zoom if available
                            if (actualLocation.heading !== undefined) {
                                gameState.roundLocations[roundKey].heading = actualLocation.heading;
                                gameState.heading = actualLocation.heading;
                            }

                            if (actualLocation.pitch !== undefined) {
                                gameState.roundLocations[roundKey].pitch = actualLocation.pitch;
                                gameState.pitch = actualLocation.pitch;
                            }

                            if (actualLocation.zoom !== undefined) {
                                gameState.roundLocations[roundKey].zoom = actualLocation.zoom;
                                gameState.zoom = actualLocation.zoom;
                            }

                            // Store score
                            if (guess.roundScore !== undefined) {
                                gameState.roundLocations[roundKey].score = guess.roundScore;
                                gameState.score = guess.roundScore;
                                DEBUG.log(`Round score: ${gameState.score}`);
                            }
                        }
                    }

                    // If no override was used, proceed with normal country info retrieval
                    if (!override) {
                        // Get country info for both guess and actual location
                        processLocationData(roundKey);
                    } else {
                        // Skip processLocationData for actual country (already set from override)
                        // Just get the guess country
                        getCountryFromCoordinates(guessCoords.lat, guessCoords.lng, true);
                    }
                }
            } else if (isInActiveRound() && data.rounds) {
                // If we're in an active round and just got location data
                DEBUG.log("Active round, processing location data");
                const currentRound = getCurrentRoundNumber() - 1; // 0-indexed

                if (data.rounds[currentRound]) {
                    const actualLocation = data.rounds[currentRound];
                    const actualCoords = sanitizeCoordinates(actualLocation.lat, actualLocation.lng);

                    if (actualCoords) {
                        // Make sure we have the correct round key
                        const roundKey = generateRoundKey();
                        gameState.currentRoundKey = roundKey;

                        // Initialize round data if needed
                        if (!gameState.roundLocations[roundKey]) {
                            gameState.roundLocations[roundKey] = {
                                panoId: null,
                                location: null,
                                heading: 0,
                                pitch: 0,
                                zoom: 0,
                                country: null,
                                countryData: null
                            };
                        }

                        // Check for country override
                        const override = checkCountryOverride(actualCoords.lat, actualCoords.lng);
                        if (override) {
                            processCountryOverride(override, roundKey);
                        }

                        // Store location data
                        gameState.roundLocations[roundKey].location = actualCoords;
                        gameState.actualLocation = actualCoords;
                        gameState.currentLocation = actualCoords;
                        gameState.dataSource = 'api';

                        // Store additional data if available
                        if (actualLocation.panoId) {
                            gameState.roundLocations[roundKey].panoId = actualLocation.panoId;
                            gameState.panoId = actualLocation.panoId;
                        }

                        if (actualLocation.heading !== undefined) {
                            gameState.roundLocations[roundKey].heading = actualLocation.heading;
                            gameState.heading = actualLocation.heading;
                        }

                        if (actualLocation.pitch !== undefined) {
                            gameState.roundLocations[roundKey].pitch = actualLocation.pitch;
                            gameState.pitch = actualLocation.pitch;
                        }

                        if (actualLocation.zoom !== undefined) {
                            gameState.roundLocations[roundKey].zoom = actualLocation.zoom;
                            gameState.zoom = actualLocation.zoom;
                        }

                        // Get country info if not overridden
                        if (!override) {
                            // If country code is available, use it
                            if (actualLocation.countryCode) {
                                gameState.countryCode = actualLocation.countryCode;
                                getCountryInfo(actualLocation.countryCode);
                            } else {
                                // Otherwise get from coordinates
                                getCountryFromCoordinates(actualCoords.lat, actualCoords.lng);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            DEBUG.error("Error parsing GeoGuessr API data", e);
        }
    }

    // Apply country override
    function processCountryOverride(override, roundKey = null) {
        if (!roundKey) {
            roundKey = gameState.currentRoundKey;
        }

        DEBUG.log(`Using country override for coordinates: ${override.country}`);
                
        // Create country data structure from override
        const countryData = {
            country: override.country,
            countryCode: override.countryCode,
            state: null,
            city: null,
            details: {
                country: override.country,
                country_code: override.countryCode.toLowerCase()
            },
            additionalInfo: override.additionalInfo
        };
        
        // Store this override in both current state and round data
        if (roundKey && gameState.roundLocations[roundKey]) {
            gameState.roundLocations[roundKey].country = override.country;
            gameState.roundLocations[roundKey].countryData = countryData;
        }
        
        gameState.actualCountry = override.country;
        gameState.countryData = countryData;
    }

    // Watch for Google Maps to load
    function watchForGoogleMaps() {
        DEBUG.log('Setting up Google Maps watcher...');

        // Check every second if Google Maps is loaded
        const checkInterval = setInterval(() => {
            if (window.google && window.google.maps) {
                DEBUG.log('Google Maps detected!');
                clearInterval(checkInterval);

                // Intercept StreetView panorama data
                interceptStreetView();
            }
        }, 1000);
    }

    // Intercept StreetView data
    function interceptStreetView() {
        if (!window.google || !window.google.maps || !window.google.maps.StreetViewPanorama) {
            DEBUG.log('Google Maps StreetView not available');
            return;
        }

        DEBUG.log('Intercepting StreetView...');

        // Store original constructor
        const originalSVP = window.google.maps.StreetViewPanorama;

        // Replace with our version
        window.google.maps.StreetViewPanorama = function(...args) {
            DEBUG.log('StreetView panorama created');

            // Call original constructor
            const panorama = new originalSVP(...args);

            // Extract location if available
            try {
                if (args[1] && args[1].position) {
                    const position = args[1].position;
                    DEBUG.log('Found position in StreetView:', position.lat(), position.lng());

                    // Only update if we're in a game and don't already have location
                    if (isInGame() && (!gameState.actualLocation || !gameState.dataSource || gameState.dataSource === 'streetview')) {
                        const validCoords = sanitizeCoordinates(position.lat(), position.lng());
                        if (validCoords) {
                            // Generate round key if not already set
                            if (!gameState.currentRoundKey) {
                                gameState.currentRoundKey = generateRoundKey();
                            }

                            // Initialize round data if needed
                            if (!gameState.roundLocations[gameState.currentRoundKey]) {
                                gameState.roundLocations[gameState.currentRoundKey] = {
                                    panoId: null,
                                    location: validCoords,
                                    heading: 0,
                                    pitch: 0,
                                    zoom: 0,
                                    country: null,
                                    countryData: null
                                };
                            } else {
                                // Update location in existing round data
                                gameState.roundLocations[gameState.currentRoundKey].location = validCoords;
                            }

                            // Update current state
                            gameState.actualLocation = validCoords;
                            gameState.currentLocation = validCoords;
                            gameState.dataSource = 'streetview';

                            // Get country info from coordinates
                            getCountryFromCoordinates(validCoords.lat, validCoords.lng);
                        }
                    }
                }

                // Add listener for position changes
                panorama.addListener('position_changed', () => {
                    try {
                        const position = panorama.getPosition();
                        if (position) {
                            DEBUG.log('StreetView position changed:', position.lat(), position.lng());

                            // Only update if we're in a game and don't have confirmed location or our data is from streetview
                            if (isInGame() && (!gameState.actualLocation || !gameState.dataSource || gameState.dataSource === 'streetview')) {
                                const validCoords = sanitizeCoordinates(position.lat(), position.lng());
                                if (validCoords) {
                                    // Generate round key if not already set
                                    if (!gameState.currentRoundKey) {
                                        gameState.currentRoundKey = generateRoundKey();
                                    }

                                    // Initialize round data if needed
                                    if (!gameState.roundLocations[gameState.currentRoundKey]) {
                                        gameState.roundLocations[gameState.currentRoundKey] = {
                                            panoId: null,
                                            location: validCoords,
                                            heading: 0,
                                            pitch: 0,
                                            zoom: 0,
                                            country: null,
                                            countryData: null
                                        };
                                    } else {
                                        // Update location in existing round data
                                        gameState.roundLocations[gameState.currentRoundKey].location = validCoords;
                                    }

                                    // Update current state
                                    gameState.actualLocation = validCoords;
                                    gameState.currentLocation = validCoords;
                                    gameState.dataSource = 'streetview';

                                    // Get country info from coordinates
                                    getCountryFromCoordinates(validCoords.lat, validCoords.lng);
                                }
                            }
                        }
                    } catch (e) {
                        DEBUG.error('Error in position_changed listener:', e);
                    }
                });
            } catch (e) {
                DEBUG.error('Error intercepting StreetViewPanorama:', e);
            }

            return panorama;
        };

        // Maintain prototype chain
        window.google.maps.StreetViewPanorama.prototype = originalSVP.prototype;
    }

    // Extract location from DOM elements
    function extractLocationFromDOM() {
        DEBUG.log('Attempting to extract location from DOM...');

        // Method 1: Check URL for coordinates (sometimes present in URL)
        const urlMatch = window.location.href.match(/\/maps\/([^\/]+)\/([^\/]+)/);
        if (urlMatch && urlMatch.length === 3) {
            const lat = parseFloat(urlMatch[1]);
            const lng = parseFloat(urlMatch[2]);

            if (!isNaN(lat) && !isNaN(lng)) {
                DEBUG.log('Found coordinates in URL:', lat, lng);

                const validCoords = sanitizeCoordinates(lat, lng);
                if (validCoords) {
                    // Generate round key if not already set
                    if (!gameState.currentRoundKey) {
                        gameState.currentRoundKey = generateRoundKey();
                    }

                    // Initialize round data if needed
                    if (!gameState.roundLocations[gameState.currentRoundKey]) {
                        gameState.roundLocations[gameState.currentRoundKey] = {
                            panoId: null,
                            location: validCoords,
                            heading: 0,
                            pitch: 0,
                            zoom: 0,
                            country: null,
                            countryData: null
                        };
                    } else {
                        // Update location in existing round data
                        gameState.roundLocations[gameState.currentRoundKey].location = validCoords;
                    }

                    // Update current state
                    gameState.actualLocation = validCoords;
                    gameState.currentLocation = validCoords;
                    gameState.dataSource = 'url';

                    // Get country info from coordinates
                    getCountryFromCoordinates(validCoords.lat, validCoords.lng);
                    return true;
                }
            }
        }

        // Method 2: Find locations in rendered DOM elements
        // (This is a fallback method that searches for coordinate-like text)
        const content = document.body.innerText;
        const coordPattern = /(-?\d+\.\d+),\s*(-?\d+\.\d+)/g;

        let match;
        while ((match = coordPattern.exec(content)) !== null) {
            const lat = parseFloat(match[1]);
            const lng = parseFloat(match[2]);

            if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                DEBUG.log('Found potential coordinates in page text:', lat, lng);

                const validCoords = sanitizeCoordinates(lat, lng);
                if (validCoords && (!gameState.actualLocation || !gameState.dataSource)) {
                    // Generate round key if not already set
                    if (!gameState.currentRoundKey) {
                        gameState.currentRoundKey = generateRoundKey();
                    }

                    // Initialize round data if needed
                    if (!gameState.roundLocations[gameState.currentRoundKey]) {
                        gameState.roundLocations[gameState.currentRoundKey] = {
                            panoId: null,
                            location: validCoords,
                            heading: 0,
                            pitch: 0,
                            zoom: 0,
                            country: null,
                            countryData: null
                        };
                    } else {
                        // Update location in existing round data
                        gameState.roundLocations[gameState.currentRoundKey].location = validCoords;
                    }

                    // Update current state
                    gameState.actualLocation = validCoords;
                    gameState.currentLocation = validCoords;
                    gameState.dataSource = 'text';

                    // Get country info from coordinates
                    getCountryFromCoordinates(validCoords.lat, validCoords.lng);
                    return true;
                }
            }
        }

        DEBUG.log('No coordinates found in DOM');
        return false;
    }

    // Process location data to get country information
    function processLocationData(roundKey) {
        if (!roundKey) {
            roundKey = gameState.currentRoundKey;
            if (!roundKey) {
                DEBUG.warn("No round key available for processLocationData");
                return;
            }
        }

        // Get the round-specific data
        const roundData = gameState.roundLocations[roundKey];
        if (!roundData) {
            DEBUG.warn(`No round data found for key ${roundKey}`);
            return;
        }

        // Check guess location
        if (isValidCoordinate(roundData.guessLocation)) {
            getCountryFromCoordinates(
                roundData.guessLocation.lat,
                roundData.guessLocation.lng,
                true
            );
        }

        // Check actual location - check for override first
        if (isValidCoordinate(roundData.location)) {
            // First check if this is a known problematic coordinate
            const override = checkCountryOverride(
                roundData.location.lat, 
                roundData.location.lng
            );
            
            if (override) {
                processCountryOverride(override, roundKey);
                return; // Skip the normal geocoding process
            }
            
            // If no override, proceed with normal geocoding
            getCountryFromCoordinates(
                roundData.location.lat,
                roundData.location.lng
            );
        }
    }

    // Fetch location overview from GeoGuessr API with robust error handling
    function fetchLocationOverview(roundKey) {
        if (!roundKey) {
            roundKey = gameState.currentRoundKey;
            if (!roundKey) {
                DEBUG.warn("No round key available for fetchLocationOverview");
                return;
            }
        }

        // Get the round-specific data
        const roundData = gameState.roundLocations[roundKey];
        if (!roundData) {
            DEBUG.warn(`No round data found for key ${roundKey}`);
            return;
        }

        if (!roundData.country || !roundData.guessCountry) {
            DEBUG.log("Missing country data, can't fetch location overview yet");
            return;
        }

        if (roundData.locationOverview) {
            DEBUG.log("Location overview already fetched");
            return;
        }

        // Get the game token from URL or data
        let gameToken = "";
        const urlMatch = window.location.href.match(/\/game\/([^\/]+)/);
        if (urlMatch && urlMatch[1]) {
            gameToken = urlMatch[1];
        } else if (gameState.gameData && gameState.gameData.token) {
            gameToken = gameState.gameData.token;
        }

        if (!gameToken) {
            DEBUG.error("Could not determine game token for location overview");
            prepareCountryClues(roundKey); // Generate basic clues anyway
            return;
        }

        const currentRound = getCurrentRoundNumber();
        const apiUrl = `https://www.geoguessr.com/api/v4/games/${gameToken}/round/${currentRound}/location-overview`;

        // Use our safe API call function with timeout
        safeApiCall(apiUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        }, 5000)
        .then(data => {
            if (!data) {
                DEBUG.warn("Failed to fetch location overview");
                prepareCountryClues(roundKey); // Generate basic clues anyway
                return;
            }

            DEBUG.log("Location overview data:", data);

            // Store in round-specific storage
            roundData.locationOverview = data;

            // Also update current state
            gameState.locationOverview = data;

            // Prepare missed clues based on country differences
            prepareCountryClues(roundKey);
        });
    }

    // Get country-specific clues with robust error handling
    function prepareCountryClues(roundKey) {
        if (!roundKey) {
            roundKey = gameState.currentRoundKey;
            if (!roundKey) {
                DEBUG.warn("No round key available for prepareCountryClues");
                return;
            }
        }

        // Get the round-specific data
        const roundData = gameState.roundLocations[roundKey];
        if (!roundData) {
            DEBUG.warn(`No round data found for key ${roundKey}`);
            return;
        }

        const missedClues = [];

        try {
            // Generate clues only if countries differ
            if (roundData.country && roundData.guessCountry &&
                roundData.country !== roundData.guessCountry) {

                // Generic clues based on country data
                if (roundData.countryData && roundData.guessCountryData) {
                    // Driving side difference
                    if (roundData.countryData.additionalInfo && roundData.guessCountryData.additionalInfo &&
                        roundData.countryData.additionalInfo.drivingSide !== roundData.guessCountryData.additionalInfo.drivingSide) {
                        missedClues.push({
                            category: "Driving Side",
                            clue: `${roundData.country} drives on the ${roundData.countryData.additionalInfo.drivingSide} side of the road (${roundData.guessCountry} drives on the ${roundData.guessCountryData.additionalInfo.drivingSide} side).`
                        });
                    }

                    // Language differences
                    if (roundData.countryData.additionalInfo && roundData.guessCountryData.additionalInfo &&
                        roundData.countryData.additionalInfo.languages && roundData.guessCountryData.additionalInfo.languages) {
                        const actualLangs = roundData.countryData.additionalInfo.languages;
                        const guessLangs = roundData.guessCountryData.additionalInfo.languages;

                        if (Array.isArray(actualLangs) && Array.isArray(guessLangs) &&
                            !arraysHaveSameElements(actualLangs, guessLangs)) {
                            missedClues.push({
                                category: "Language",
                                clue: `${roundData.country}'s language(s): ${actualLangs.join(', ')} (different from ${roundData.guessCountry}'s: ${guessLangs.join(', ')})`
                            });
                        }
                    }

                    // Top-level domain difference
                    if (roundData.countryData.additionalInfo && roundData.guessCountryData.additionalInfo &&
                        roundData.countryData.additionalInfo.tld !== roundData.guessCountryData.additionalInfo.tld) {
                        missedClues.push({
                            category: "Internet TLD",
                            clue: `${roundData.country}'s internet domain is ${roundData.countryData.additionalInfo.tld} (${roundData.guessCountry}'s is ${roundData.guessCountryData.additionalInfo.tld}).`
                        });
                    }
                }

                // Add location-specific clues based on location overview
                if (roundData.locationOverview) {
                    // Add a clue about the geographic region if available
                    if (roundData.locationOverview.region) {
                        missedClues.push({
                            category: "Geographic Region",
                            clue: `This location is in the ${roundData.locationOverview.region} region of ${roundData.country}.`
                        });
                    }

                    // Add clue about camera type/meta data if available
                    if (roundData.locationOverview.coverage && roundData.locationOverview.coverage.type) {
                        missedClues.push({
                            category: "Coverage Type",
                            clue: `This is ${roundData.locationOverview.coverage.type} coverage in ${roundData.country}.`
                        });
                    }
                }

                // Add a generic reminder clue if we don't have many clues
                if (missedClues.length < 2) {
                    missedClues.push({
                        category: "General Appearance",
                        clue: `Pay closer attention to license plates, road markings, and signage in ${roundData.country} to distinguish it from ${roundData.guessCountry}.`
                    });
                }
            }
        } catch (e) {
            DEBUG.error("Error preparing country clues", e);

            // Add a fallback clue
            missedClues.push({
                category: "General",
                clue: `Pay attention to distinctive features in ${roundData.country || "this country"}.`
            });
        }

        // Store in round-specific storage
        roundData.missedClues = missedClues;

        // Also update current state
        gameState.missedClues = missedClues;

        DEBUG.log("Generated clues:", missedClues);
    }

    function arraysHaveSameElements(arr1, arr2) {
        if (!Array.isArray(arr1) || !Array.isArray(arr2) || arr1.length !== arr2.length) return false;

        const set1 = new Set(arr1);
        for (const item of arr2) {
            if (!set1.has(item)) return false;
        }
        return true;
    }

    // Get country info from coordinates using Nominatim with robust error handling
    async function getCountryFromCoordinates(lat, lng, isGuess = false) {
        try {
            DEBUG.log(`Getting country info for ${lat}, ${lng} (isGuess: ${isGuess})`);

            // Validate coordinates
            const coords = sanitizeCoordinates(lat, lng);
            if (!coords) {
                DEBUG.warn(`Invalid coordinates: ${lat}, ${lng}`);
                return null;
            }

            // First check if this coordinate has a known override
            const override = checkCountryOverride(lat, lng);
            if (override && !isGuess) {
                processCountryOverride(override);
                return;
            }

            const url = `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lng}&format=json&addressdetails=1`;

            const data = await safeApiCall(url);
            if (!data) {
                DEBUG.warn("Failed to get country info from Nominatim");
                return null;
            }

            DEBUG.log("Nominatim response received", data);

            if (!data.address || !data.address.country) {
                DEBUG.warn("Country not found in Nominatim response");
                return null;
            }

            const country = data.address.country;
            const countryCode = data.address.country_code ? data.address.country_code.toUpperCase() : null;

            // Get additional country info from REST Countries API
            let additionalInfo = {
                tld: 'Unknown',
                drivingSide: 'Unknown',
                languages: ['Unknown'],
                currency: 'Unknown',
                flagUrl: null,
                continent: 'Unknown',
                capital: 'Unknown'
            };

            if (countryCode) {
                try {
                    const restUrl = `https://restcountries.com/v3.1/alpha/${countryCode}`;
                    DEBUG.log(`Fetching additional country info from ${restUrl}`);

                    const restData = await safeApiCall(restUrl);
                    if (restData && restData[0]) {
                        const countryData = restData[0];

                        additionalInfo = {
                            tld: countryData.tld && countryData.tld.length > 0 ? countryData.tld[0] : 'Unknown',
                            drivingSide: countryData.car && countryData.car.side ? countryData.car.side : 'Unknown',
                            languages: countryData.languages ? Object.values(countryData.languages) : ['Unknown'],
                            currency: countryData.currencies ? Object.values(countryData.currencies)[0].name : 'Unknown',
                            flagUrl: countryCode ? `https://flagcdn.com/w320/${countryCode.toLowerCase()}.png` : null,
                            continent: countryData.continents && countryData.continents.length > 0 ? countryData.continents[0] : 'Unknown',
                            capital: countryData.capital && countryData.capital.length > 0 ? countryData.capital[0] : 'Unknown'
                        };
                    }
                } catch (e) {
                    DEBUG.error("Error getting additional country info", e);
                }
            }

            const result = {
                country: country,
                countryCode: countryCode,
                state: data.address.state || data.address.county || null,
                city: data.address.city || data.address.town || data.address.village || null,
                details: data.address,
                additionalInfo: additionalInfo
            };

            DEBUG.log("Processed country info", result);

            // Update state based on whether this is a guess or actual location
            if (isGuess) {
                // Generate round key if not already set
                if (!gameState.currentRoundKey) {
                    gameState.currentRoundKey = generateRoundKey();
                }

                // Update guess country data
                if (gameState.roundLocations[gameState.currentRoundKey]) {
                    gameState.roundLocations[gameState.currentRoundKey].guessCountry = country;
                    gameState.roundLocations[gameState.currentRoundKey].guessCountryData = result;
                }

                // Update current state
                gameState.guessCountry = country;
                gameState.guessCountryData = result;

                // If we have both actual and guess countries, fetch location overview
                if (gameState.roundLocations[gameState.currentRoundKey]?.country) {
                    fetchLocationOverview(gameState.currentRoundKey);
                }
            } else {
                // Generate round key if not already set
                if (!gameState.currentRoundKey) {
                    gameState.currentRoundKey = generateRoundKey();
                }

                // Update actual country data
                if (gameState.roundLocations[gameState.currentRoundKey]) {
                    gameState.roundLocations[gameState.currentRoundKey].country = country;
                    gameState.roundLocations[gameState.currentRoundKey].countryData = result;
                }

                // Update current state
                gameState.actualCountry = country;
                gameState.countryData = result;

                // If we have both actual and guess countries, fetch location overview
                if (gameState.roundLocations[gameState.currentRoundKey]?.guessCountry) {
                    fetchLocationOverview(gameState.currentRoundKey);
                }
            }

            return result;
        } catch (e) {
            DEBUG.error("Error fetching country info from coordinates", e);
            return null;
        }
    }

    // Get country info from country code
    function getCountryInfo(countryCode) {
        if (!countryCode) {
            DEBUG.warn("No country code provided");
            return;
        }

        DEBUG.log('Fetching country info for code:', countryCode);

        // Use RestCountries API for details
        fetch(`https://restcountries.com/v3.1/alpha/${countryCode}`)
            .then(response => response.json())
            .then(data => {
                if (data && data.length > 0) {
                    const countryData = data[0];
                    
                    DEBUG.log('Received country data:', countryData.name);

                    // Create our country data structure
                    const result = {
                        country: countryData.name.common,
                        countryCode: countryCode,
                        state: null,
                        city: null,
                        details: {
                            country: countryData.name.common,
                            country_code: countryCode.toLowerCase()
                        },
                        additionalInfo: {
                            tld: countryData.tld && countryData.tld.length > 0 ? countryData.tld[0] : 'Unknown',
                            drivingSide: countryData.car && countryData.car.side ? countryData.car.side : 'Unknown',
                            languages: countryData.languages ? Object.values(countryData.languages) : ['Unknown'],
                            currency: countryData.currencies ? Object.values(countryData.currencies)[0].name : 'Unknown',
                            flagUrl: `https://flagcdn.com/w320/${countryCode.toLowerCase()}.png`,
                            continent: countryData.continents && countryData.continents.length > 0 ? countryData.continents[0] : 'Unknown',
                            capital: countryData.capital && countryData.capital.length > 0 ? countryData.capital[0] : 'Unknown'
                        }
                    };

                    // Store data in game state
                    gameState.countryData = result;
                    gameState.actualCountry = countryData.name.common;

                    // Also update round-specific data
                    if (gameState.currentRoundKey && gameState.roundLocations[gameState.currentRoundKey]) {
                        gameState.roundLocations[gameState.currentRoundKey].country = countryData.name.common;
                        gameState.roundLocations[gameState.currentRoundKey].countryData = result;
                    }

                    DEBUG.log('Country info updated', result);
                }
            })
            .catch(error => {
                DEBUG.error('Error fetching country details:', error);
            });
    }

    // More robust DOM extraction with multiple fallback approaches
    function extractCountryFromDOM() {
        DEBUG.log("Attempting to extract country from DOM");

        try {
            // Define selectors in order of preference
            const addressSelectors = [
                'div[data-qa="address"]',
                '.address',
                '[class^="result-layout_addressContainer__"]',
                'div[class*="address"]',
                'div[class*="location"]',
                'div[class*="country"]'
            ];

            // Try all selectors
            let addressElement = null;
            for (const selector of addressSelectors) {
                addressElement = safeQuerySelector(selector);
                if (addressElement) break;
            }

            if (addressElement) {
                const addressText = addressElement.innerText || addressElement.textContent;
                DEBUG.log(`Found address element with text: "${addressText}"`);

                if (addressText && addressText.includes(',')) {
                    const parts = addressText.split(',');
                    const country = parts[parts.length - 1].trim();
                    if (country && country.length > 1) {
                        DEBUG.log(`Extracted country from DOM: "${country}"`);
                        return country;
                    }
                }
            }

            // Try other potential elements that might contain country info
            const resultElements = document.querySelectorAll('[class*="result"]:not(button)');
            for (const element of resultElements) {
                if (!element) continue;

                const text = element.innerText || element.textContent;
                if (!text) continue;

                DEBUG.log(`Checking result element for country: "${text}"`);

                // Look for patterns like "The correct location was in [Country]"
                const patterns = [
                    /(?:location|place)\s+(?:is|was)(?:\s+in)?\s+([A-Za-z\s]+)(?:\.|,)/i,
                    /correct(?:\s+answer)?\s+(?:is|was)\s+(?:in)?\s+([A-Za-z\s]+)/i,
                    /([A-Za-z\s]+)\s+was\s+the\s+(?:correct|right)\s+(?:country|answer)/i
                ];

                for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match && match[1]) {
                        const country = match[1].trim();
                        DEBUG.log(`Found country in result text: "${country}"`);
                        return country;
                    }
                }
            }

            // Try to extract from document title as a last resort
            const title = document.title;
            DEBUG.log(`Page title: "${title}"`);
            if (title && title.includes('-')) {
                const parts = title.split('-');
                const lastPart = parts[parts.length - 1].trim();
                if (lastPart && lastPart.length > 2 && lastPart.length < 30) {
                    DEBUG.log(`Possible country from page title: "${lastPart}"`);
                    return lastPart;
                }
            }
        } catch (e) {
            DEBUG.error("Error extracting country from DOM", e);
        }

        DEBUG.warn("Could not extract country from DOM");
        return null;
    }

    /* ========= ANKI CARD BUILDING ========= */
    function buildAnkiCardData(useDefaults = false) {
        const roundKey = gameState.currentRoundKey;
        if (!roundKey) {
            DEBUG.error("No round key available for buildAnkiCardData");
            return null;
        }

        // Get the round-specific data
        const roundData = gameState.roundLocations[roundKey];
        if (!roundData) {
            DEBUG.error(`No round data found for key ${roundKey} when building Anki card`);
            return null;
        }

        // For instant add, we can use default values for missing data
        if (useDefaults) {
            if (!roundData.country) {
                // Try DOM extraction if API data is missing
                const extractedCountry = extractCountryFromDOM();
                if (extractedCountry) {
                    roundData.country = extractedCountry;
                    gameState.actualCountry = extractedCountry;
                } else {
                    // Use a default value if we can't determine the country
                    roundData.country = "Unknown Country";
                    gameState.actualCountry = "Unknown Country";
                }
            }

            if (!roundData.guessCountry) {
                // Use a default for guessed country
                roundData.guessCountry = "Unknown Guess";
                gameState.guessCountry = "Unknown Guess";
            }
        } else {
            // For regular add, ensure we have the necessary data
            if (!roundData.country || !roundData.guessCountry) {
                DEBUG.error("Missing country data for Anki card");
                return null;
            }
        }

        // Prepare Street View link for the correct location
        let mapsLink = "#";
        if (isValidCoordinate(roundData.location)) {
            const lat = roundData.location.lat.toFixed(6);
            const lng = roundData.location.lng.toFixed(6);

            // Create a proper Street View link with panoId if available
            if (roundData.panoId) {
                mapsLink = createStreetViewLink(
                    lat, lng,
                    roundData.panoId,
                    roundData.heading || 0,
                    roundData.pitch || 0,
                    roundData.zoom || 0
                );
            } else {
                mapsLink = `https://www.google.com/maps/@${lat},${lng},3a,90y,0h,0t/data=!3m1!1e1`;
            }

            // Validate the generated URL
            if (!mapsLink || mapsLink === "#" || !mapsLink.startsWith("http")) {
                DEBUG.warn("Generated invalid Maps URL, using fallback");
                mapsLink = `https://www.google.com/maps/@${lat},${lng},12z`;
            }
        }

        // Get location names with null checking
        const guessCity = roundData.guessCountryData && roundData.guessCountryData.city ?
            roundData.guessCountryData.city : "Unknown location";
        const actualCity = roundData.countryData && roundData.countryData.city ?
            roundData.countryData.city : "Unknown location";

        // Get additional info with null checking
        const continent = roundData.countryData && roundData.countryData.additionalInfo &&
            roundData.countryData.additionalInfo.continent ?
            roundData.countryData.additionalInfo.continent : "Unknown";

        const drivingSide = roundData.countryData && roundData.countryData.additionalInfo &&
            roundData.countryData.additionalInfo.drivingSide ?
            roundData.countryData.additionalInfo.drivingSide : "Unknown";

        // Front of card (question) - hide location link based on settings
        let frontField;
        if (mapsLink && mapsLink !== "#" && !settings.hideLocationInFrontCard) {
            // Only show maps link if explicitly enabled in settings
            frontField = `You guessed ${roundData.guessCountry}, but the correct answer was ${roundData.country}. What clues did you miss? 🌍<br><br>
🔗 <a href="${mapsLink}" target="_blank">Google Maps Link: View Correct Location</a>`;
        } else {
            // Default: Hide location link to prevent leaking coordinates
            frontField = `You guessed ${roundData.guessCountry}, but the correct answer was ${roundData.country}. What clues did you miss? 🌍`;
        }

        // Flag image URL with fallback
        let flagUrl = "";
        let flagHtml = "";

        if (roundData.countryData && roundData.countryData.countryCode) {
            flagUrl = `https://flagcdn.com/w320/${roundData.countryData.countryCode.toLowerCase()}.png`;
            flagHtml = ` <img src="${flagUrl}" class="flag-image" alt="Flag of ${roundData.country}" onerror="this.style.display='none'">`;
        }

        // Back of card (answer) - uses user's custom input or default content
        let backField = `<h3>✅ Correct Answer: <strong>${roundData.country}</strong>${flagHtml}</h3>
<h3>❌ Mistake: Guessed ${roundData.guessCountry}</h3>

<p>📍 <strong>Your Guess:</strong> ${guessCity}, <strong>${roundData.guessCountry}</strong></p>
<p>📍 <strong>Correct Location:</strong> ${actualCity}, <strong>${roundData.country}</strong></p>`;

        // Only show Maps link in the back of the card
        if (mapsLink && mapsLink !== "#") {
            backField += `
<p>🔗 <a href="${mapsLink}" target="_blank">View on Google Maps</a></p>`;
        }

        backField += `
<p>🌎 <strong>Continent:</strong> <strong>${continent}</strong></p>
<p>🚗 <strong>Driving Side:</strong> <strong>${drivingSide}</strong></p>`;

        // Use user's custom missed clues if provided and not using defaults,
        // otherwise use the generated ones or a generic fallback for instant add
        if (gameState.userMissedClues && gameState.userMissedClues.trim() && !useDefaults) {
            backField += `
<h3>🛑 Key Clues You Missed:</h3>
<p>${gameState.userMissedClues}</p>`;
        } else {
            backField += `
<h3>🛑 Key Clues You Missed:</h3>
<ul>`;
            // Add missed clues with null checking
            if (roundData.missedClues && roundData.missedClues.length > 0) {
                roundData.missedClues.forEach(clue => {
                    if (clue && clue.category && clue.clue) {
                        backField += `<li><strong>${clue.category}:</strong> ${clue.clue}</li>`;
                    }
                });
            } else {
                backField += `<li><strong>General:</strong> Pay attention to distinctive features in ${roundData.country}.</li>`;
            }
            backField += `</ul>`;
        }

        // Use user's custom reminder if provided and not using defaults,
        // otherwise use the generated one or a generic fallback for instant add
        if (gameState.userReminder && gameState.userReminder.trim() && !useDefaults) {
            backField += `
<h3>Next Time, Remember:</h3>
<p>⚡ <em>${gameState.userReminder}</em></p>`;
        } else {
            backField += `
<h3>Next Time, Remember:</h3>
<p>⚡ <em>"If it looks like ${roundData.guessCountry} but has ${getSingleDistinctiveClue(roundKey)} → Think ${roundData.country}!"</em></p>`;
        }

        return {
            frontField: frontField,
            backField: backField,
            mapsLink: mapsLink,
            actualCountry: roundData.country,
            guessCountry: roundData.guessCountry,
            roundKey: roundKey
        };
    }

    function getSingleDistinctiveClue(roundKey) {
        if (!roundKey) {
            roundKey = gameState.currentRoundKey;
            if (!roundKey) {
                DEBUG.warn("No round key available for getSingleDistinctiveClue");
                return "distinctive local features";
            }
        }

        // Get the round-specific data
        const roundData = gameState.roundLocations[roundKey];
        if (!roundData) {
            DEBUG.warn(`No round data found for key ${roundKey}`);
            return "distinctive local features";
        }

        try {
            // Extract a single distinctive clue for quick reference
            if (roundData.missedClues && roundData.missedClues.length > 0) {
                // Try to find a specific, concrete clue
                for (const clue of roundData.missedClues) {
                    // Look for specific clue categories
                    if (["Driving Side", "Language", "Coverage Type"].includes(clue.category)) {
                        // Extract a short distinctive feature from the clue
                        const extractedDetail = clue.clue.match(/has (.+?) (?:signs|poles|antennas|coverage)/i);
                        if (extractedDetail && extractedDetail[1]) {
                            return `${extractedDetail[1]}`;
                        }

                        // If we can't extract a specific detail, return a shortened version
                        const shortClue = clue.clue.split('(')[0].trim();
                        if (shortClue.length < 50) return shortClue;
                    }
                }

                // Fallback to first clue if we couldn't find a good specific one
                if (roundData.missedClues[0] && roundData.missedClues[0].clue) {
                    const firstClue = roundData.missedClues[0].clue;
                    // Shorten it to make it more memorable
                    const shortened = firstClue.split('.')[0];
                    return shortened.length < 40 ? shortened : "different road markings or signs";
                }
            }

            // Check if we have driving side info as a default distinctive feature
            if (roundData.countryData && roundData.countryData.additionalInfo &&
                roundData.countryData.additionalInfo.drivingSide !== "Unknown") {
                return `drives on the ${roundData.countryData.additionalInfo.drivingSide} side`;
            }
        } catch (e) {
            DEBUG.error("Error getting distinctive clue", e);
        }

        return "distinctive local features";
    }

    // Enhanced function to handle round end events with improved robustness
    function handleRoundEnd() {
        DEBUG.log("Handling round end...");

        // Reset any timeouts to prevent race conditions
        window.geoAnkiTimeouts.forEach(clearTimeout);
        window.geoAnkiTimeouts = [];

        try {
            // Get the current round key
            const roundKey = generateRoundKey();
            gameState.currentRoundKey = roundKey;

            // Make sure we have round data initialized
            if (!gameState.roundLocations[roundKey]) {
                gameState.roundLocations[roundKey] = {
                    panoId: gameState.panoId,
                    location: gameState.actualLocation,
                    heading: gameState.heading,
                    pitch: gameState.pitch,
                    zoom: gameState.zoom,
                    country: gameState.actualCountry,
                    countryData: gameState.countryData,
                    guessLocation: gameState.guessLocation,
                    guessCountry: gameState.guessCountry,
                    guessCountryData: gameState.guessCountryData,
                    score: gameState.score,
                    missedClues: gameState.missedClues,
                    locationOverview: gameState.locationOverview
                };
            }

            // Check for country override based on coordinates
            if (isValidCoordinate(gameState.roundLocations[roundKey].location)) {
                const override = checkCountryOverride(
                    gameState.roundLocations[roundKey].location.lat,
                    gameState.roundLocations[roundKey].location.lng
                );
                
                if (override) {
                    processCountryOverride(override, roundKey);
                }
            }

            // Reset user reflection data for fresh input
            gameState.userMissedClues = "";
            gameState.userReminder = "";

            // Reset card created flag for this round
            gameState.cardCreatedForRound = false;
            gameState.cancelCardCreation = false;

            // Use DOM extraction as a fallback if API fetching failed
            if (!gameState.roundLocations[roundKey].country) {
                const extractedCountry = extractCountryFromDOM();
                if (extractedCountry) {
                    DEBUG.log(`Extracted country from DOM: ${extractedCountry}`);
                    gameState.roundLocations[roundKey].country = extractedCountry;
                    gameState.actualCountry = extractedCountry;

                    // Create basic country data structure if missing
                    if (!gameState.roundLocations[roundKey].countryData) {
                        gameState.roundLocations[roundKey].countryData = {
                            country: extractedCountry,
                            countryCode: null,
                            additionalInfo: {
                                drivingSide: "Unknown",
                                continent: "Unknown"
                            }
                        };
                        gameState.countryData = gameState.roundLocations[roundKey].countryData;
                    }

                    // Try to get user's guess from UI elements
                    const resultElements = document.querySelectorAll('[class*="result-layout"]:not(button), [class*="result"]:not(button)');
                    for (const element of resultElements) {
                        if (!element) continue;

                        const text = element.innerText || element.textContent;
                        if (!text) continue;

                        DEBUG.log(`Checking result element for guess: "${text}"`);
                        const match = text.match(/You\s+guessed\s+([A-Za-z\s]+)/i);
                        if (match && match[1]) {
                            const guessCountry = match[1].trim();
                            gameState.roundLocations[roundKey].guessCountry = guessCountry;
                            gameState.guessCountry = guessCountry;

                            gameState.roundLocations[roundKey].guessCountryData = {
                                country: guessCountry,
                                countryCode: null,
                                additionalInfo: {}
                            };
                            gameState.guessCountryData = gameState.roundLocations[roundKey].guessCountryData;

                            DEBUG.log(`Extracted guess country: ${guessCountry}`);
                            break;
                        }
                    }

                    // Generate basic missed clues
                    if (!gameState.roundLocations[roundKey].missedClues || gameState.roundLocations[roundKey].missedClues.length === 0) {
                        prepareCountryClues(roundKey);
                    }
                }
            }

            // If automatic cards are enabled and not in battle royale or duel mode, prompt for card creation
            const gameType = getGameType();
            if (settings.automaticCards && gameType !== 'battle-royale' && gameType !== 'duel') {
                DEBUG.log("Auto cards enabled, will prompt for card creation");
                
                // Set a slight delay to allow any remaining API data to be processed
                const timeoutId = setTimeout(() => {
                    promptForCardCreation();
                }, 1500);
                
                window.geoAnkiTimeouts.push(timeoutId);
            }

            // Update UI state to reflect we're between rounds
            updateUIState({ inActiveRound: false });
        } catch (e) {
            DEBUG.error("Error in handleRoundEnd", e);
        }
    }

    /* ========= ANKI INTEGRATION ========= */
    // Create card directly without showing preview
    function createAnkiCard(cardData, useDefaults = false) {
        if (!cardData) {
            cardData = buildAnkiCardData(useDefaults);
        }

        if (!cardData) {
            showNotification("Couldn't prepare Anki card - missing data", "error");
            return;
        }

        DEBUG.log("Creating Anki card with data:", cardData);

        // Create Anki note
        const note = {
            deckName: DECK_NAME,
            modelName: MODEL_NAME,
            fields: {
                "Front": cardData.frontField,
                "Back": cardData.backField
            },
            options: { allowDuplicate: false }
        };

        // Send to Anki
        sendNoteToAnki(note, cardData.roundKey);
    }

    // Send a note to Anki with robust error handling
    function sendNoteToAnki(note, roundKey) {
        DEBUG.log("Sending note to Anki");

        if (!note) {
            showNotification("No note data to send", "error");
            return;
        }

        // First, check the model fields to ensure compatibility
        safeGmXhr({
            method: "POST",
            url: ANKI_CONNECT_URL,
            data: JSON.stringify({
                action: "modelFieldNames",
                version: 6,
                params: {
                    modelName: MODEL_NAME
                }
            }),
            headers: { "Content-Type": "application/json" },
            timeout: 10000
        })
        .then(result => {
            if (result.error) {
                showNotification(`Anki Error: ${result.error}`, 'error');
                return;
            }

            const availableFields = result.result;
            DEBUG.log("Available fields in model:", availableFields);

            // Create a new note with fields matching the model
            const adaptedFields = {};

            // Different note types have different field names
            if (availableFields.includes("Front") && availableFields.includes("Back")) {
                adaptedFields.Front = note.fields.Front;
                adaptedFields.Back = note.fields.Back;
            } else {
                // For each available field, try to find a match
                availableFields.forEach(field => {
                    // Convert to lowercase for case-insensitive matching
                    const fieldLower = field.toLowerCase();

                    if (fieldLower === "front" || fieldLower.includes("question")) {
                        adaptedFields[field] = note.fields.Front;
                    }
                    else if (fieldLower === "back" || fieldLower.includes("answer")) {
                        adaptedFields[field] = note.fields.Back;
                    }
                    else {
                        // For unknown fields, leave empty
                        adaptedFields[field] = "";
                    }
                });
            }

            // Create the adapted note
            const adaptedNote = {
                deckName: DECK_NAME,
                modelName: MODEL_NAME,
                fields: adaptedFields,
                options: { allowDuplicate: false }
            };

            DEBUG.log("Adapted note ready to send");

            // Now send the adapted note
            return safeGmXhr({
                method: "POST",
                url: ANKI_CONNECT_URL,
                data: JSON.stringify({
                    action: "addNote",
                    version: 6,
                    params: { note: adaptedNote }
                }),
                headers: { "Content-Type": "application/json" },
                timeout: 10000
            });
        })
        .then(addResult => {
            if (!addResult) return; // Request might have failed earlier

            if (addResult.error) {
                showNotification(`Anki Error: ${addResult.error}`, 'error');

                // Show more detailed error dialog for model problems
                if (addResult.error.includes("model")) {
                    showErrorDialog("Model Error",
                        `The script couldn't create a note because your Anki note model doesn't match the expected fields.<br><br>
                        <strong>Troubleshooting:</strong><br>
                        • Make sure you have a note type named "${MODEL_NAME}" in Anki<br>
                        • For best results, use a "Basic" note type with just "Front" and "Back" fields<br>
                        • You can change the model name in the script settings`);
                }
            } else {
                // Card created successfully, mark this round as processed
                if (roundKey) {
                    gameState.cardCreatedForRound = true;
                    // Mark the round-specific flag too
                    if (gameState.roundLocations[roundKey]) {
                        gameState.roundLocations[roundKey].cardCreated = true;
                    }
                }

                showNotification(`Card added to Anki deck "${DECK_NAME}".`, 'success');

                // Reset user input fields after successful card creation
                gameState.userMissedClues = "";
                gameState.userReminder = "";
            }
        })
        .catch(error => {
            DEBUG.error("Anki connection error", error);
            showNotification('Failed to connect to AnkiConnect. Is Anki running?', 'error');
        });
    }

    // Check if the required deck and model exist in Anki
    function checkDeckAndModel() {
        DEBUG.log("Checking Anki deck and model");

        // Check if deck exists
        safeGmXhr({
            method: "POST",
            url: ANKI_CONNECT_URL,
            data: JSON.stringify({
                action: "deckNames",
                version: 6
            }),
            headers: { "Content-Type": "application/json" },
            timeout: 5000
        })
        .then(result => {
            if (result.error) {
                showNotification(`Anki Error: ${result.error}`, 'error');
                return;
            }

            const decks = result.result;
            const deckExists = decks.includes(DECK_NAME);

            if (!deckExists) {
                // Deck doesn't exist, create it
                DEBUG.log(`Deck "${DECK_NAME}" not found, creating...`);
                return safeGmXhr({
                    method: "POST",
                    url: ANKI_CONNECT_URL,
                    data: JSON.stringify({
                        action: "createDeck",
                        version: 6,
                        params: {
                            deck: DECK_NAME
                        }
                    }),
                    headers: { "Content-Type": "application/json" },
                    timeout: 5000
                });
            } else {
                DEBUG.log(`Deck "${DECK_NAME}" exists`);
                return { result: "Deck exists" };
            }
        })
        .then(createResult => {
            if (createResult && createResult.error) {
                showNotification(`Error creating deck: ${createResult.error}`, 'error');
            } else if (createResult && createResult.result !== "Deck exists") {
                showNotification(`Created deck "${DECK_NAME}"`, 'success');
            }

            // Now check if the note model exists
            return safeGmXhr({
                method: "POST",
                url: ANKI_CONNECT_URL,
                data: JSON.stringify({
                    action: "modelNames",
                    version: 6
                }),
                headers: { "Content-Type": "application/json" },
                timeout: 5000
            });
        })
        .then(modelResult => {
            if (!modelResult) return; // Request might have failed

            if (modelResult.error) {
                showNotification(`Anki Error: ${modelResult.error}`, 'error');
                return;
            }

            const models = modelResult.result;
            const modelExists = models.includes(MODEL_NAME);

            if (modelExists) {
                showNotification(`Note type "${MODEL_NAME}" exists. You're ready to go!`, 'success');
            } else {
                // Show warning about missing model
                showErrorDialog("Anki Setup Required",
                    `The note type "${MODEL_NAME}" doesn't exist in your Anki collection.<br><br>
                    <strong>To set up:</strong><br>
                    1. Open Anki<br>
                    2. Click "Tools" > "Manage Note Types"<br>
                    3. Click "Add"<br>
                    4. Select "Basic" from the list<br>
                    5. Name it "${MODEL_NAME}" <strong>exactly</strong><br>
                    6. Click "OK"<br><br>
                    Alternatively, use a standard "Basic" note type by changing the note type name in settings to "Basic".`);
            }
        })
        .catch(error => {
            DEBUG.error("Error checking Anki configuration", error);
            showNotification("Failed to connect to Anki. Is it running with AnkiConnect?", "error");
        });
    }

    function showErrorDialog(title, message) {
        showSettingsPanel(title, message);
    }

    // Improved card creation function with instant add option
    function createCardWithOptions(useInstantAdd = false) {
        if (!settings.enableAnkiIntegration) {
            showNotification("Anki integration is disabled in settings.", "info");
            return;
        }

        // Double-check we're not in an active round
        if (isInActiveRound()) {
            showNotification("Card creation is not allowed during active rounds.", "error");
            return;
        }

        // Get the current round key
        const roundKey = gameState.currentRoundKey;
        if (!roundKey) {
            showNotification("No active round data found.", "error");
            return;
        }

        // If user cancelled card creation, respect that choice
        if (gameState.cancelCardCreation) {
            DEBUG.log("Card creation was previously cancelled by user");
            return;
        }

        // Check if we already created a card for this round
        if (gameState.cardCreatedForRound) {
            if (confirm("You've already created a card for this round. Create another?")) {
                // Continue - user confirmed they want another card
                gameState.cardCreatedForRound = false;
            } else {
                showNotification("Card creation cancelled.", "info");
                return;
            }
        }

        // For instant add, bypass the prompts and use available data
        if (useInstantAdd || settings.instantAddEnabled) {
            DEBUG.log("Using instant add without prompts");
            createAnkiCard(null, true);
            return;
        }

        // Get round-specific data
        const roundData = gameState.roundLocations[roundKey];
        if (!roundData) {
            showNotification("No data found for current round.", "error");
            return;
        }

        // Ensure we have the country data needed
        if (!roundData.country) {
            // Try DOM extraction if API data is missing
            const extractedCountry = extractCountryFromDOM();
            if (extractedCountry) {
                roundData.country = extractedCountry;
                gameState.actualCountry = extractedCountry;
                DEBUG.log(`Using DOM-extracted country: ${extractedCountry}`);

                if (!roundData.countryData) {
                    roundData.countryData = {
                        country: extractedCountry,
                        countryCode: null,
                        additionalInfo: {
                            drivingSide: "Unknown",
                            continent: "Unknown"
                        }
                    };
                    gameState.countryData = roundData.countryData;
                }
            } else {
                showNotification("Couldn't determine the correct country. Try again.", "error");
                return;
            }
        }

        DEBUG.log("Starting card creation workflow with round data:", roundData);

        // Launch the prompting workflow
        promptForCardCreation();
    }

    // New function to handle the card creation prompt workflow
    function promptForCardCreation() {
        try {
            // If user cancelled card creation, respect that choice
            if (gameState.cancelCardCreation) {
                DEBUG.log("Card creation was cancelled by user, skipping prompts");
                return;
            }

            // Get round-specific data
            const roundKey = gameState.currentRoundKey;
            if (!roundKey) {
                DEBUG.warn("No round key for promptForCardCreation");
                return;
            }

            const roundData = gameState.roundLocations[roundKey];
            if (!roundData || !roundData.country) {
                DEBUG.warn("Missing data for promptForCardCreation");
                return;
            }

            // Create overlay to prevent interaction with the page below
            const overlay = document.createElement('div');
            overlay.className = 'geo-anki-overlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100%';
            overlay.style.height = '100%';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
            overlay.style.zIndex = '9998';
            document.body.appendChild(overlay);

            // Create HTML prompt container
            const promptContainer = document.createElement('div');
            promptContainer.className = 'geo-anki-prompt';
            promptContainer.id = 'geo-anki-prompt-container';
            promptContainer.style.position = 'fixed';
            promptContainer.style.top = '50%';
            promptContainer.style.left = '50%';
            promptContainer.style.transform = 'translate(-50%, -50%)';
            promptContainer.style.backgroundColor = 'rgba(30, 30, 30, 0.95)';
            promptContainer.style.color = 'white';
            promptContainer.style.padding = '20px';
            promptContainer.style.borderRadius = '8px';
            promptContainer.style.zIndex = '9999';
            promptContainer.style.width = '400px';
            promptContainer.style.maxWidth = '90%';
            promptContainer.style.boxShadow = '0 4px 20px rgba(0,0,0,0.4)';
            promptContainer.style.fontFamily = 'Arial, sans-serif';

            // Create the content programmatically rather than using innerHTML
            const title = document.createElement('h2');
            title.style.textAlign = 'center';
            title.style.marginTop = '0';
            title.textContent = 'Create Anki Card';
            promptContainer.appendChild(title);

            // Create guess country section
            const guessLabel = document.createElement('p');
            guessLabel.textContent = 'What country did you guess?';
            promptContainer.appendChild(guessLabel);

            const guessInput = document.createElement('input');
            guessInput.type = 'text';
            guessInput.id = 'geo-anki-guess';
            guessInput.value = roundData.guessCountry || '';
            guessInput.style.width = '100%';
            guessInput.style.padding = '8px';
            guessInput.style.boxSizing = 'border-box';
            guessInput.style.marginBottom = '15px';
            guessInput.style.backgroundColor = 'rgba(60,60,60,0.8)';
            guessInput.style.color = 'white';
            guessInput.style.border = '1px solid #555';
            promptContainer.appendChild(guessInput);

            // Create missed clues section
            const cluesLabel = document.createElement('p');
            cluesLabel.textContent = 'What clues did you miss? (Leave blank for auto-generated)';
            promptContainer.appendChild(cluesLabel);

            const cluesTextarea = document.createElement('textarea');
            cluesTextarea.id = 'geo-anki-clues';
            cluesTextarea.style.width = '100%';
            cluesTextarea.style.padding = '8px';
            cluesTextarea.style.boxSizing = 'border-box';
            cluesTextarea.style.height = '80px';
            cluesTextarea.style.marginBottom = '15px';
            cluesTextarea.style.backgroundColor = 'rgba(60,60,60,0.8)';
            cluesTextarea.style.color = 'white';
            cluesTextarea.style.border = '1px solid #555';
            promptContainer.appendChild(cluesTextarea);

            // Create reminder section
            const reminderLabel = document.createElement('p');
            reminderLabel.textContent = `What will you remember next time to identify ${roundData.country}? (Leave blank for auto-generated)`;
            promptContainer.appendChild(reminderLabel);

            const reminderTextarea = document.createElement('textarea');
            reminderTextarea.id = 'geo-anki-reminder';
            reminderTextarea.style.width = '100%';
            reminderTextarea.style.padding = '8px';
            reminderTextarea.style.boxSizing = 'border-box';
            reminderTextarea.style.height = '60px';
            reminderTextarea.style.marginBottom = '20px';
            reminderTextarea.style.backgroundColor = 'rgba(60,60,60,0.8)';
            reminderTextarea.style.color = 'white';
            reminderTextarea.style.border = '1px solid #555';
            promptContainer.appendChild(reminderTextarea);

            // Create buttons container
            const buttonContainer = document.createElement('div');
            buttonContainer.style.display = 'flex';
            buttonContainer.style.justifyContent = 'space-between';
            
            // Create cancel button
            const cancelButton = document.createElement('button');
            cancelButton.id = 'geo-anki-cancel';
            cancelButton.textContent = 'Cancel';
            cancelButton.style.padding = '8px 16px';
            cancelButton.style.backgroundColor = '#e74c3c';
            cancelButton.style.color = 'white';
            cancelButton.style.border = 'none';
            cancelButton.style.borderRadius = '4px';
            cancelButton.style.cursor = 'pointer';
            buttonContainer.appendChild(cancelButton);

            // Create right side buttons container
            const rightButtonContainer = document.createElement('div');
            
            // Create instant add button
            const instantButton = document.createElement('button');
            instantButton.id = 'geo-anki-instant';
            instantButton.textContent = 'Instant Add';
            instantButton.style.padding = '8px 16px';
            instantButton.style.backgroundColor = '#3498db';
            instantButton.style.color = 'white';
            instantButton.style.border = 'none';
            instantButton.style.borderRadius = '4px';
            instantButton.style.cursor = 'pointer';
            instantButton.style.marginRight = '10px';
            rightButtonContainer.appendChild(instantButton);

            // Create create button
            const createButton = document.createElement('button');
            createButton.id = 'geo-anki-create';
            createButton.textContent = 'Create Card';
            createButton.style.padding = '8px 16px';
            createButton.style.backgroundColor = '#2ecc71';
            createButton.style.color = 'white';
            createButton.style.border = 'none';
            createButton.style.borderRadius = '4px';
            createButton.style.cursor = 'pointer';
            rightButtonContainer.appendChild(createButton);
            
            buttonContainer.appendChild(rightButtonContainer);
            promptContainer.appendChild(buttonContainer);

            // Create checkbox section
            const checkboxContainer = document.createElement('div');
            checkboxContainer.style.marginTop = '15px';
            
            const checkboxLabel = document.createElement('label');
            checkboxLabel.style.display = 'flex';
            checkboxLabel.style.alignItems = 'center';
            checkboxLabel.style.cursor = 'pointer';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = 'geo-anki-instant-toggle';
            checkbox.style.marginRight = '8px';
            checkbox.checked = settings.instantAddEnabled;
            
            checkboxLabel.appendChild(checkbox);
            checkboxLabel.appendChild(document.createTextNode('Always use instant add in the future'));
            
            checkboxContainer.appendChild(checkboxLabel);
            promptContainer.appendChild(checkboxContainer);

            // Add to document
            document.body.appendChild(promptContainer);

            // Set focus to the guess field after a small delay to ensure the element is ready
            setTimeout(() => {
                if (guessInput) guessInput.focus();
            }, 100);

            // Event handlers using direct DOM references rather than getElementById
            const handleCancel = function() {
                DEBUG.log("Cancel button clicked");
                // Mark that user cancelled card creation for this round
                gameState.cancelCardCreation = true;
                // Remove the elements from DOM
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                if (promptContainer && promptContainer.parentNode) {
                    promptContainer.parentNode.removeChild(promptContainer);
                }
                showNotification("Card creation cancelled", "info");
            };

            const handleInstantAdd = function() {
                DEBUG.log("Instant Add button clicked");
                // Save the "Always use instant add" setting
                const instantToggle = document.getElementById('geo-anki-instant-toggle');
                if (instantToggle) {
                    settings.instantAddEnabled = instantToggle.checked;
                    GM_setValue('instantAddEnabled', settings.instantAddEnabled);
                }
                
                // Remove prompt and create card immediately
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                if (promptContainer && promptContainer.parentNode) {
                    promptContainer.parentNode.removeChild(promptContainer);
                }
                createAnkiCard(null, true);
            };

            const handleCreateCard = function() {
                DEBUG.log("Create Card button clicked");
                // Get entered values
                const guessValue = guessInput ? guessInput.value.trim() : '';
                const cluesValue = cluesTextarea ? cluesTextarea.value.trim() : '';
                const reminderValue = reminderTextarea ? reminderTextarea.value.trim() : '';
                
                // Save the "Always use instant add" setting
                const instantToggle = document.getElementById('geo-anki-instant-toggle');
                if (instantToggle) {
                    settings.instantAddEnabled = instantToggle.checked;
                    GM_setValue('instantAddEnabled', settings.instantAddEnabled);
                }
                
                // Remove prompt
                if (overlay && overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
                if (promptContainer && promptContainer.parentNode) {
                    promptContainer.parentNode.removeChild(promptContainer);
                }

                // Update state with entered values
                if (guessValue) {
                    // Update guess country
                    gameState.guessCountry = guessValue;
                    if (roundData) {
                        roundData.guessCountry = guessValue;
                        roundData.guessCountryData = roundData.guessCountryData || {
                            country: guessValue,
                            city: "Unknown location",
                            countryCode: null,
                            additionalInfo: {}
                        };
                    }
                }

                if (cluesValue) {
                    gameState.userMissedClues = cluesValue;
                }

                if (reminderValue) {
                    gameState.userReminder = reminderValue;
                }

                // Create the card
                createAnkiCard();
            };

            // Attach event listeners directly to the button references
            if (cancelButton) cancelButton.addEventListener('click', handleCancel);
            if (instantButton) instantButton.addEventListener('click', handleInstantAdd);
            if (createButton) createButton.addEventListener('click', handleCreateCard);
            
            // Also allow clicking outside the prompt to cancel
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    handleCancel();
                }
            });
            
            // Add Escape key handler
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    handleCancel();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
            
            DEBUG.log("Prompt created and event handlers attached");
        } catch (e) {
            DEBUG.error("Error in card creation prompt", e);
            showNotification("Error creating card prompt", "error");
        }
    }

    /* ========= UI & NAVIGATION ========= */
    
    // Create UI with iframe for protection from CSS/JS interference
    function createUIContainer() {
        // Check if container already exists
        if (document.getElementById('geoguessr-anki-container')) {
            return;
        }
        
        // Create our container iframe
        const iframe = document.createElement('iframe');
        iframe.id = 'geoguessr-anki-container';
        
        // Set styles to position it at the bottom-right
        iframe.style.position = 'fixed';
        iframe.style.bottom = '20px';
        iframe.style.right = '20px';
        iframe.style.width = '150px';
        iframe.style.height = '300px';
        iframe.style.border = 'none';
        iframe.style.background = 'transparent';
        iframe.style.zIndex = '2147483647'; // Maximum z-index
        
        // Add it to the page
        document.body.appendChild(iframe);
        
        // Get the iframe's document
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        
        // Write the HTML for our UI
        iframeDoc.open();
        iframeDoc.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body, html {
                        margin: 0;
                        padding: 0;
                        overflow: hidden;
                        font-family: Arial, sans-serif;
                    }
                    
                    /* Main button styles */
                    #toggle-button {
                        position: absolute;
                        bottom: 0;
                        right: 0;
                        width: 48px;
                        height: 48px;
                        background-color: #4CAF50;
                        border-radius: 50%;
                        color: white;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                        transition: all 0.3s ease;
                        z-index: 10;
                    }
                    
                    #toggle-button:hover {
                        transform: scale(1.1);
                    }
                    
                    /* Action buttons container */
                    #action-buttons {
                        position: absolute;
                        bottom: 58px;
                        right: 0;
                        display: flex;
                        flex-direction: column;
                        align-items: flex-end;
                        gap: 10px;
                        opacity: 0;
                        transform: translateY(20px);
                        transition: all 0.3s ease;
                        pointer-events: none;
                    }
                    
                    #action-buttons.expanded {
                        opacity: 1;
                        transform: translateY(0);
                        pointer-events: auto;
                    }
                    
                    /* Action button style */
                    .action-button {
                        width: 40px;
                        height: 40px;
                        background-color: #4CAF50;
                        border-radius: 50%;
                        color: white;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                        transition: all 0.2s ease;
                        position: relative;
                    }
                    
                    .action-button:hover {
                        transform: scale(1.1);
                    }
                    
                    .action-button:active {
                        transform: scale(0.95);
                    }
                    
                    /* Button label/tooltip */
                    .button-label {
                        position: absolute;
                        right: 50px;
                        background-color: rgba(0,0,0,0.7);
                        color: white;
                        padding: 4px 8px;
                        border-radius: 4px;
                        font-size: 12px;
                        white-space: nowrap;
                        opacity: 0;
                        transition: opacity 0.2s;
                        pointer-events: none;
                    }
                    
                    .action-button:hover .button-label {
                        opacity: 1;
                    }
                    
                    /* Disabled button state */
                    .action-button.disabled {
                        background-color: #888888;
                        cursor: not-allowed;
                    }

                    /* Instant add button */
                    #instant-add-button {
                        background-color: #2196F3;
                    }
                </style>
            </head>
            <body>
                <!-- Main toggle button -->
                <div id="toggle-button">▶◀</div>
                
                <!-- Container for action buttons -->
                <div id="action-buttons">
                    <!-- Create Card Button -->
                    <div class="action-button" id="create-card-button">
                        🃏
                        <div class="button-label">Create Anki Card</div>
                    </div>
                    
                    <!-- Instant Add Button -->
                    <div class="action-button" id="instant-add-button">
                        ⚡
                        <div class="button-label">Instant Add Card</div>
                    </div>
                    
                    <!-- Settings Button -->
                    <div class="action-button" id="settings-button">
                        ⚙️
                        <div class="button-label">Settings</div>
                    </div>
                    
                    <!-- Debug Button -->
                    <div class="action-button" id="debug-button">
                        🐞
                        <div class="button-label">Debug</div>
                    </div>
                </div>
                
                <script>
                    // Toggle button functionality
                    const toggleButton = document.getElementById('toggle-button');
                    const actionButtons = document.getElementById('action-buttons');
                    let isExpanded = false;
                    
                    // Check localStorage for previous state
                    try {
                        isExpanded = localStorage.getItem('geoAnkiUIExpanded') === 'true';
                        if (isExpanded) {
                            actionButtons.classList.add('expanded');
                            toggleButton.textContent = '◀▶';
                        }
                    } catch (e) {
                        console.error('Error reading from localStorage:', e);
                    }
                    
                    // Toggle button click handler
                    toggleButton.addEventListener('click', function() {
                        isExpanded = !isExpanded;
                        
                        if (isExpanded) {
                            actionButtons.classList.add('expanded');
                            toggleButton.textContent = '◀▶';
                        } else {
                            actionButtons.classList.remove('expanded');
                            toggleButton.textContent = '▶◀';
                        }
                        
                        // Save state to localStorage
                        try {
                            localStorage.setItem('geoAnkiUIExpanded', isExpanded);
                        } catch (e) {
                            console.error('Error writing to localStorage:', e);
                        }
                    });
                    
                    // Create card button
                    document.getElementById('create-card-button').addEventListener('click', function() {
                        parent.postMessage({ action: 'createCard' }, '*');
                    });

                    // Instant Add button
                    document.getElementById('instant-add-button').addEventListener('click', function() {
                        parent.postMessage({ action: 'instantAdd' }, '*');
                    });
                    
                    // Settings button
                    document.getElementById('settings-button').addEventListener('click', function() {
                        parent.postMessage({ action: 'openSettings' }, '*');
                    });
                    
                    // Debug button
                    document.getElementById('debug-button').addEventListener('click', function() {
                        parent.postMessage({ action: 'debug' }, '*');
                    });
                    
                    // Handle incoming messages from parent window
                    window.addEventListener('message', function(event) {
                        console.log('Message received:', event.data);
                        
                        // Handle state updates
                        if (event.data.type === 'updateState') {
                            const createCardButton = document.getElementById('create-card-button');
                            const instantAddButton = document.getElementById('instant-add-button');
                            
                            if (event.data.inActiveRound) {
                                // Disable create card button during active rounds
                                createCardButton.classList.add('disabled');
                                createCardButton.querySelector('.button-label').textContent = 'Finish round first';
                                instantAddButton.classList.add('disabled');
                                instantAddButton.querySelector('.button-label').textContent = 'Finish round first';
                            } else {
                                // Enable create card button between rounds
                                createCardButton.classList.remove('disabled');
                                createCardButton.querySelector('.button-label').textContent = 'Create Anki Card';
                                instantAddButton.classList.remove('disabled');
                                instantAddButton.querySelector('.button-label').textContent = 'Instant Add Card';
                            }
                        }
                    });
                    
                    // Notify parent that UI is ready
                    parent.postMessage({ action: 'uiReady' }, '*');
                </script>
            </body>
            </html>
        `);
        iframeDoc.close();
        
        DEBUG.log('GeoGuessr Anki UI created successfully');
    }
    
    // Handle messages from the iframe
    function setupMessageHandlers() {
        window.addEventListener('message', function(event) {
            DEBUG.log('Received message from UI:', event.data);
            
            // Handle different actions
            switch(event.data.action) {
                case 'uiReady':
                    DEBUG.log('UI is ready');
                    // Update UI state based on current game state
                    updateUIState({
                        inActiveRound: isInActiveRound()
                    });
                    break;
                    
                case 'createCard':
                    DEBUG.log('Create card button clicked');
                    createCardWithOptions(false);
                    break;
                    
                case 'instantAdd':
                    DEBUG.log('Instant add button clicked');
                    createCardWithOptions(true);
                    break;
                    
                case 'openSettings':
                    DEBUG.log('Settings button clicked');
                    showSettingsPanel();
                    break;
                    
                case 'debug':
                    DEBUG.log('Debug button clicked');
                    DEBUG.copyLogsToClipboard();
                    showNotification("Debug logs copied to clipboard", "success");
                    break;
            }
        });
    }
    
    // Update the UI state
    function updateUIState(state) {
        const iframe = document.getElementById('geoguessr-anki-container');
        if (!iframe) return;
        
        // Send state updates to the iframe
        iframe.contentWindow.postMessage({
            type: 'updateState',
            ...state
        }, '*');
    }

    // Shows a settings/modal panel
    function showSettingsPanel(title = "GeoGuessr Anki Settings", content = null) {
        // Create the overlay
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
        overlay.style.zIndex = '2147483646';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        
        // Create the panel
        const panel = document.createElement('div');
        panel.style.backgroundColor = 'rgba(40,40,40,0.95)';
        panel.style.color = '#E0E0E0';
        panel.style.padding = '20px';
        panel.style.borderRadius = '8px';
        panel.style.width = '80%';
        panel.style.maxWidth = '500px';
        panel.style.maxHeight = '80vh';
        panel.style.overflowY = 'auto';
        panel.style.boxShadow = '0 3px 20px rgba(0,0,0,0.5)';
        
        // If content is provided, use that instead of settings form
        if (content) {
            panel.innerHTML = `
                <h2 style="color:#ffcc00;">${title}</h2>
                <div>${content}</div>
                <button id="close-panel" style="
                    background-color: #4CAF50;
                    color: white;
                    border: none;
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-top: 15px;
                ">Close</button>
            `;
            
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
            
            document.getElementById('close-panel').addEventListener('click', function() {
                document.body.removeChild(overlay);
            });
            
            return;
        }
        
        // Otherwise show settings
        panel.innerHTML = `
            <h2>${title}</h2>
            <div style="margin-bottom: 15px;">
                <label for="anki-deck">Anki Deck Name:</label>
                <input type="text" id="anki-deck" style="
                    background-color: rgba(30,30,30,0.8);
                    border: 1px solid #555;
                    color: #E0E0E0;
                    padding: 8px;
                    border-radius: 4px;
                    width: 100%;
                    margin-top: 5px;
                " value="${settings.ankiDefaultDeck}">
            </div>
            <div style="margin-bottom: 15px;">
                <label for="model-name">Anki Note Type:</label>
                <input type="text" id="model-name" style="
                    background-color: rgba(30,30,30,0.8);
                    border: 1px solid #555;
                    color: #E0E0E0;
                    padding: 8px;
                    border-radius: 4px;
                    width: 100%;
                    margin-top: 5px;
                " value="${settings.modelName}">
            </div>
            <div style="margin-bottom: 15px;">
                <label for="anki-port">Anki Connect Port:</label>
                <input type="number" id="anki-port" style="
                    background-color: rgba(30,30,30,0.8);
                    border: 1px solid #555;
                    color: #E0E0E0;
                    padding: 8px;
                    border-radius: 4px;
                    width: 100%;
                    margin-top: 5px;
                " value="${settings.ankiConnectPort}">
            </div>
            <div style="margin-bottom: 15px;">
                <label>
                    <input type="checkbox" id="anki-enabled" ${settings.enableAnkiIntegration ? 'checked' : ''}>
                    Enable Anki Integration
                </label>
            </div>
            <div style="margin-bottom: 15px;">
                <label>
                    <input type="checkbox" id="auto-cards" ${settings.automaticCards ? 'checked' : ''}>
                    Auto Prompt After Rounds
                </label>
            </div>
            <div style="margin-bottom: 15px;">
                <label>
                    <input type="checkbox" id="instant-add" ${settings.instantAddEnabled ? 'checked' : ''}>
                    Enable Instant Add (Skip prompts)
                </label>
            </div>
            <div style="margin-bottom: 15px;">
                <label>
                    <input type="checkbox" id="hide-location" ${settings.hideLocationInFrontCard ? 'checked' : ''}>
                    Hide Location in Front Card (Recommended)
                </label>
            </div>
            <div style="margin-bottom: 15px;">
                <label>
                    <input type="checkbox" id="debug-mode" ${DEBUG.enabled ? 'checked' : ''}>
                    Enable Debug Mode
                </label>
            </div>
            <div style="margin-bottom: 15px;">
                <button id="test-anki-btn" style="
                    background-color: #666;
                    color: white;
                    border: none;
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-right: 10px;
                ">Test Anki Connection</button>
            </div>
            <button id="save-settings" style="
                background-color: #4CAF50;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                margin-top: 10px;
            ">Save Settings</button>
            <button id="close-panel" style="
                background-color: #666;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                margin-top: 10px;
                margin-left: 10px;
            ">Cancel</button>
        `;
        
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        
        // Add event listeners
        document.getElementById('close-panel').addEventListener('click', function() {
            document.body.removeChild(overlay);
        });
        
        document.getElementById('test-anki-btn').addEventListener('click', function() {
            checkDeckAndModel();
        });
        
        document.getElementById('save-settings').addEventListener('click', function() {
            // Save all settings
            settings.ankiDefaultDeck = document.getElementById('anki-deck').value;
            settings.modelName = document.getElementById('model-name').value;
            settings.ankiConnectPort = parseInt(document.getElementById('anki-port').value) || 8765;
            settings.enableAnkiIntegration = document.getElementById('anki-enabled').checked;
            settings.automaticCards = document.getElementById('auto-cards').checked;
            settings.hideLocationInFrontCard = document.getElementById('hide-location').checked;
            settings.instantAddEnabled = document.getElementById('instant-add').checked;
            DEBUG.enabled = document.getElementById('debug-mode').checked;
            
            // Update global variables
            DECK_NAME = settings.ankiDefaultDeck;
            MODEL_NAME = settings.modelName;
            ANKI_CONNECT_URL = "http://localhost:" + settings.ankiConnectPort;
            
            // Save to GM storage
            GM_setValue('geoguessr_anki_settings', settings);
            GM_setValue('instantAddEnabled', settings.instantAddEnabled);
            
            showNotification('Settings saved!', 'success');
            document.body.removeChild(overlay);
        });
    }

    // Show a notification popup
    function showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.style.position = 'fixed';
        notification.style.top = '20px';
        notification.style.left = '50%';
        notification.style.transform = 'translateX(-50%)';
        notification.style.padding = '10px 20px';
        notification.style.borderRadius = '5px';
        notification.style.backgroundColor = type === 'success' ? 'rgba(50,150,50,0.9)' : 
                                            type === 'error' ? 'rgba(150,50,50,0.9)' : 
                                            'rgba(50,50,50,0.9)';
        notification.style.color = 'white';
        notification.style.boxShadow = '0 3px 10px rgba(0,0,0,0.3)';
        notification.style.zIndex = '2147483645';
        notification.style.fontFamily = 'Arial, sans-serif';
        notification.style.fontSize = '14px';
        notification.style.transition = 'opacity 0.3s ease';
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        // Remove after a delay
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                try {
                    document.body.removeChild(notification);
                } catch (e) {
                    // Element might already be removed
                }
            }, 300);
        }, 3000);
    }

    // Ensure UI is visible
    function ensureUIVisibility() {
        if (!document.getElementById('geoguessr-anki-container') && document.body) {
            createUIContainer();
            setupMessageHandlers();
        }
    }

    // Game state tracking
    function gameLoop(forceCheck = false) {
        try {
            // Ensure UI is always present
            ensureUIVisibility();
            
            // Get current state
            const nowInGame = isInGame();
            const nowInRound = isInActiveRound();
            const currentRound = getCurrentRoundNumber();
            
            // Update button states based on active round
            updateUIState({ inActiveRound: nowInRound });

            // Handle game state changes
            if (nowInGame !== gameState.inGame || forceCheck) {
                gameState.inGame = nowInGame;
                DEBUG.log('Game state change -', nowInGame ? 'Entered game' : 'Left game');
    
                if (!nowInGame) {
                    // Reset state when leaving a game
                    resetRoundData();
                }
            }

            // Handle round state changes
            if (nowInRound !== gameState.inRound || (nowInRound && currentRound !== gameState.roundNumber) || forceCheck) {
                gameState.inRound = nowInRound;
                gameState.roundNumber = currentRound;

                DEBUG.log('Round state change -',
                    nowInRound ? `Started round ${currentRound}` : 'Ended round',
                    'Current location:', gameState.actualLocation);

                if (nowInRound) {
                    // New round started, try to get location data again
                    gameState.currentRoundKey = generateRoundKey();
                    interceptLocationData();
                } else if (!nowInRound && gameState.inRound) {
                    // Round just ended
                    if (!gameState.isProcessingRound) {
                        gameState.isProcessingRound = true;
                        handleRoundEnd();
                        setTimeout(() => {
                            gameState.isProcessingRound = false;
                        }, 1000);
                    }
                }
            }

            // If we're in a round but don't have location data, keep trying
            if (nowInRound && !gameState.actualLocation) {
                // Periodically try to get location data
                if (Math.random() < 0.2) { // 20% chance each second to avoid excessive calls
                    interceptLocationData();
                }
            }
        } catch (e) {
            DEBUG.error("Error in game loop", e);
        }
    }

    /* ========= INITIALIZATION & CLEANUP ========= */
    // Create a persistent interval to ensure the UI exists
    function setupPersistence() {
        setInterval(function() {
            if (!document.getElementById('geoguessr-anki-container') && document.body) {
                DEBUG.log('UI missing, recreating...');
                createUIContainer();
                setupMessageHandlers();
            }
        }, 5000);
    }
    
    // Cleanup function to clear all timeouts and intervals
    function cleanup() {
        // Clear any timeouts
        window.geoAnkiTimeouts.forEach(clearTimeout);
        window.geoAnkiTimeouts = [];

        // Clear any intervals
        window.geoAnkiIntervals.forEach(clearInterval);
        window.geoAnkiIntervals = [];

        // Trim debug logs
        DEBUG.trimLogs();
    }

    // Initialize everything
    function init() {
        DEBUG.log('GeoGuessr Anki Integration initializing...');

        // Only run on GeoGuessr
        if (!isGeoGuessr()) {
            DEBUG.log('Not on GeoGuessr; stopping initialization.');
            return;
        }

        // Setup XHR interception for game data
        setupXHRInterception();
        
        // Setup fetch interception
        interceptFetch();
        
        // Setup URL change detection
        setupUrlChangeDetection();
        
        // Initialize UI
        if (document.body) {
            createUIContainer();
            setupMessageHandlers();
        } else {
            // Body not available yet, retry after a short delay
            const initTimeout = setTimeout(init, 100);
            window.geoAnkiTimeouts.push(initTimeout);
            return;
        }
        
        // Setup persistence checking
        setupPersistence();
        
        // Setup game state tracking
        const gameStateInterval = setInterval(() => gameLoop(), 1000);
        window.geoAnkiIntervals.push(gameStateInterval);
        
        // Setup cleanup interval
        const cleanupInterval = setInterval(cleanup, 60000); // every minute
        window.geoAnkiIntervals.push(cleanupInterval);

        // Register Tampermonkey menu command
        GM_registerMenuCommand('GeoGuessr Anki Settings', showSettingsPanel);
        
        // Set up visibility change handler
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                ensureUIVisibility();
                gameLoop(true);
            }
        });
        
        // Set up mutation observer to detect DOM changes
        if (window.MutationObserver) {
            try {
                const observer = new MutationObserver(() => {
                    if (!document.getElementById('geoguessr-anki-container') && document.body) {
                        ensureUIVisibility();
                    }
                });
                
                if (document.body) {
                    observer.observe(document.body, { childList: true, subtree: true });
                }
            } catch (e) {
                DEBUG.warn('Failed to set up mutation observer:', e);
            }
        }

        DEBUG.log('GeoGuessr Anki Integration initialized!');
    }

    // Initialize when the DOM is ready or after a delay if already loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // Try immediately
        init();
        
        // Also try after a delay as a fallback
        setTimeout(init, 500);
    }
    
    // Additional initialization attempts for reliability
    window.addEventListener('load', () => {
        if (!document.getElementById('geoguessr-anki-container')) {
            DEBUG.log('Window load event triggered - initializing UI');
            init();
        }
    });
    
    // Clean up on page unload
    window.addEventListener('beforeunload', cleanup);
})();
