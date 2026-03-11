/**
 * InstaInsight - Instagram Analysis Logic
 * 
 * Logic to parse Instagram Data Export ZIP and calculate relationships.
 */

class InstagramAnalyzer {
    constructor() {
        this.followers = new Set();
        this.following = new Set();
        this.mutuals = [];
        this.fans = [];
        this.notFollowingBack = [];
    }

    /**
     * Main entry point to process the ZIP file.
     * @param {File} file - The uploaded ZIP file.
     * @param {Function} updateStatusCallback - Callback for status updates.
     */
    async processZip(file, updateStatusCallback) {
        try {
            updateStatusCallback('Membaca file ZIP...', 'Harap tunggu');
            const zip = await JSZip.loadAsync(file);

            updateStatusCallback('Mencari data...', 'Memindai struktur folder');
            const followersFile = this.findFileInZip(zip, [
                'followers_1.json', 'followers.json',
                'followers_1.html', 'followers.html'
            ]);

            const followingFile = this.findFileInZip(zip, [
                'following.json', 'following_1.json',
                'following.html', 'following_1.html'
            ]);

            if (!followersFile || !followingFile) {
                throw new Error('File data tidak ditemukan. Pastikan ZIP berasal dari Instagram "Download your information" dan berisi followers/following (format JSON atau HTML).');
            }

            updateStatusCallback('Menganalisis Followers...', `Memproses ${followersFile.name}`);
            const followersContent = await followersFile.async('string');
            const followersList = this.parseData(followersFile.name, followersContent);
            this.followers = new Set(followersList);

            // 3. Parse Following
            updateStatusCallback('Menganalisis Following...', `Memproses ${followingFile.name}`);
            const followingContent = await followingFile.async('string');
            const followingList = this.parseData(followingFile.name, followingContent, true);
            this.following = new Set(followingList);

            // 4. Compute Relationships
            updateStatusCallback('Menghitung hubungan...', 'Hampir selesai');
            this.computeRelationships();

            return {
                stats: {
                    followers: this.followers.size,
                    following: this.following.size,
                    mutuals: this.mutuals.length,
                    fans: this.fans.length,
                    notFollowingBack: this.notFollowingBack.length
                },
                details: {
                    mutuals: this.mutuals,
                    fans: this.fans,
                    notFollowingBack: this.notFollowingBack
                }
            };

        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    /**
     * Computes Mutuals, Fans, and NotFollowingBack lists.
     */
    computeRelationships() {
        // Mutuals: You follow them AND they follow you
        this.mutuals = [...this.following].filter(user => this.followers.has(user));

        // Fans: They follow you BUT you don't follow them
        this.fans = [...this.followers].filter(user => !this.following.has(user));

        // Not Following Back: You follow them BUT they don't follow you
        this.notFollowingBack = [...this.following].filter(user => !this.followers.has(user));
    }

    /**
     * Robust file finder that searches recursively (flat zip structure).
     */
    findFileInZip(zip, possibleNames) {
        // First check standard paths
        for (const name of possibleNames) {
            // Check root
            if (zip.file(name)) return zip.file(name);

            // Search in all files for end match
            const match = Object.keys(zip.files).find(path => path.endsWith('/' + name) || path === name);
            if (match) return zip.file(match);
        }
        return null; // Not found
    }

    /**
     * Parses content based on file type.
     */
    parseData(fileName, content, isFollowingFile = false) {
        if (fileName.endsWith('.json')) {
            return this.parseJson(content, isFollowingFile);
        } else if (fileName.endsWith('.html')) {
            return this.parseHtml(content);
        }
        return [];
    }

    parseJson(jsonString, isFollowingFile) {
    try {
        const data = JSON.parse(jsonString);
        let rawList = [];

        // Case A: Standard Key (if object)
        if (!Array.isArray(data)) {
            if (isFollowingFile && Array.isArray(data.relationships_following)) {
                rawList = data.relationships_following;
            } else if (Array.isArray(data.relationships_followers)) {
                rawList = data.relationships_followers;
            } else {
                // Fallback: find first array in object
                const keys = Object.keys(data);
                for (const key of keys) {
                    if (Array.isArray(data[key])) {
                        rawList = data[key];
                        break;
                    }
                }
            }
        } else {
            // Case B: Top level array
            rawList = data;
        }

        // Extract usernames (support multiple IG export formats)
        const usernames = [];

        const extractUsername = (item) => {
            // Followers format: item.string_list_data[0].value
            const v = item?.string_list_data?.[0]?.value;
            if (typeof v === 'string' && v.trim()) return v.trim();

            // Following format (your ZIP): item.title
            const t = item?.title;
            if (typeof t === 'string' && t.trim()) return t.trim();

            return null;
        };

        if (Array.isArray(rawList)) {
            rawList.forEach(item => {
                const u = extractUsername(item);
                if (u) usernames.push(u);
            });
        }

        return usernames;

    } catch (e) {
        console.error("JSON Parse Error", e);
        throw new Error('Gagal membaca format file JSON. Struktur data mungkin telah berubah.');
    }
}

    parseHtml(htmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');

        // Ambil semua link yang relevan
        const links = Array.from(doc.querySelectorAll('a'));

        const usernames = [];

        const extractFromHref = (href) => {
            if (!href) return null;

            // Normalisasi
            const h = href.trim();

            // Contoh:
            // https://www.instagram.com/username/
            // https://instagram.com/username?...
            // /username/
            const m = h.match(/(?:https?:\/\/(?:www\.)?instagram\.com\/|^\/)([A-Za-z0-9._]+)(?:[\/?#]|$)/i);
            if (!m) return null;

            const u = m[1]?.trim();
            if (!u) return null;

            // Filter yang bukan profil user
            const blacklist = new Set([
            'accounts', 'explore', 'reels', 'p', 'tv', 'stories', 'about', 'privacy', 'terms'
            ]);
            if (blacklist.has(u.toLowerCase())) return null;

            return u;
        };

        const looksLikeUsername = (text) => {
            if (!text) return false;
            const t = text.trim();
            if (!t) return false;
            // username IG: huruf/angka/._, panjang wajar
            return /^[A-Za-z0-9._]{1,30}$/.test(t);
        };

        for (const a of links) {
            const href = a.getAttribute('href');
            const text = (a.textContent || '').trim();

            // 1) Prioritas dari href instagram.com/username
            const fromHref = extractFromHref(href);
            if (fromHref) {
            usernames.push(fromHref);
            continue;
            }

            // 2) Fallback: kadang username cuma ada sebagai teks
            if (looksLikeUsername(text)) {
            usernames.push(text);
            }
        }

        // Dedup + bersihkan
        return Array.from(new Set(usernames))
            .map(u => u.trim())
            .filter(Boolean);
    }
}


const ui = {
    elements: {
        dropZone: document.getElementById('drop-zone'),
        zipInput: document.getElementById('zipInput'),
        loadingState: document.getElementById('loading-state'),
        loadingText: document.getElementById('loading-text'),
        loadingSubtext: document.getElementById('loading-subtext'),
        resultsSection: document.getElementById('results-section'),
        statsGrid: document.getElementById('stats-grid'),
        uploadSection: document.getElementById('upload-section'),
        tabContent: document.getElementById('tab-content'),
        searchInput: document.getElementById('search-input'),
        tabButtons: document.querySelectorAll('.tab-btn'),
        // Stat counters
        statFollowers: document.getElementById('stat-followers'),
        statFollowing: document.getElementById('stat-following'),
        statMutuals: document.getElementById('stat-mutuals'),
        statFans: document.getElementById('stat-fans'),
        statNotBack: document.getElementById('stat-notback'),
    },

    state: {
        currentData: null,
        activeTab: 'not-following-back' // default
    },

    init() {
        this.addEventListeners();
    },

    addEventListeners() {
        // Drag & Drop
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            this.elements.dropZone.parentElement.addEventListener(eventName, preventDefaults, false);
        });

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        ['dragenter', 'dragover'].forEach(eventName => {
            this.elements.dropZone.parentElement.addEventListener(eventName, () => {
                this.elements.dropZone.parentElement.classList.add('bg-slate-800/50', 'border-cyan-400');
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            this.elements.dropZone.parentElement.addEventListener(eventName, () => {
                this.elements.dropZone.parentElement.classList.remove('bg-slate-800/50', 'border-cyan-400');
            });
        });

        this.elements.dropZone.parentElement.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files.length) this.handleFile(files[0]);
        });

        this.elements.zipInput.addEventListener('change', (e) => {
            if (e.target.files.length) this.handleFile(e.target.files[0]);
        });

        // Tabs
        this.elements.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });

        // Search
        this.elements.searchInput.addEventListener('input', (e) => {
            this.renderList(this.state.activeTab, e.target.value);
        });
    },

    async handleFile(file) {
        if (!file.name.endsWith('.zip')) {
            alert('Mohon unggah file dengan format .zip');
            return;
        }

        this.showLoading(true);
        this.updateLoadingText('Menganalisis...', 'Membaca file ZIP');
        await new Promise(r => setTimeout(r, 500));

        const analyzer = new InstagramAnalyzer();

        try {
            const result = await analyzer.processZip(file, (title, sub) => {
                this.updateLoadingText(title, sub);
            });

            this.state.currentData = result.details;
            this.updateStats(result.stats);
            this.showResults();
            this.switchTab('not-following-back');

            // Tampilkan tombol Upload Ulang (desktop + mobile)
            const resetBtn = document.getElementById('reset-btn');
            const resetBtnMobile = document.getElementById('reset-btn-mobile');

            if (resetBtn) resetBtn.classList.remove('hidden');
            if (resetBtnMobile) resetBtnMobile.classList.remove('hidden');

            const doReset = () => window.location.reload();

            resetBtn?.addEventListener('click', doReset);
            resetBtnMobile?.addEventListener('click', doReset);

        } catch (error) {
            alert(error.message);
            window.location.reload();
        } finally {
            setTimeout(() => {
                this.showLoading(false);
            }, 300);
        }
    },

    showLoading(show) {
        if (show) {
            this.elements.loadingState.classList.remove('hidden');
        } else {
            this.elements.loadingState.classList.add('hidden');
        }
    },

    updateLoadingText(title, sub) {
        this.elements.loadingText.textContent = title;
        this.elements.loadingSubtext.textContent = sub;
    },

    updateStats(stats) {
        this.elements.statFollowers.textContent = stats.followers.toLocaleString();
        this.elements.statFollowing.textContent = stats.following.toLocaleString();
        this.elements.statMutuals.textContent = stats.mutuals.toLocaleString();
        this.elements.statFans.textContent = stats.fans.toLocaleString();
        this.elements.statNotBack.textContent = stats.notFollowingBack.toLocaleString();
    },

    showResults() {
        this.elements.uploadSection.classList.add('hidden');
        this.elements.statsGrid.classList.remove('hidden');
        this.elements.resultsSection.classList.remove('hidden');

        // Paksa reveal tampil (mobile-safe)
        this.elements.statsGrid.classList.add('show');
        this.elements.resultsSection.classList.add('show');
        this.elements.tabContent.classList.add('show');
        this.elements.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    switchTab(tabName) {
        this.state.activeTab = tabName;

        // Update Buttons
        this.elements.tabButtons.forEach(btn => {
            if (btn.dataset.tab === tabName) {
                btn.classList.remove('text-slate-400', 'hover:text-white', 'bg-transparent');
                btn.classList.add('bg-cyan-500', 'text-slate-900');
            } else {
                btn.classList.add('text-slate-400', 'hover:text-white', 'bg-transparent');
                btn.classList.remove('bg-cyan-500', 'text-slate-900');
            }
        });

        // Render Content
        this.renderList(tabName, this.elements.searchInput.value);
    },

    renderList(category, filter = '') {
        const container = this.elements.tabContent;
        container.innerHTML = ''; // Clear

        let data = [];
        let emptyMessage = '';
        let iconClass = '';

        if (category === 'mutuals') {
            data = this.state.currentData.mutuals;
            emptyMessage = 'Tidak ada mutual connections.';
            iconClass = 'fa-handshake';
        } else if (category === 'fans') {
            data = this.state.currentData.fans;
            emptyMessage = 'Tidak ada fans unik.';
            iconClass = 'fa-heart';
        } else {
            data = this.state.currentData.notFollowingBack;
            emptyMessage = 'Semua orang follow back Anda! (Atau Anda tidak follow siapa-siapa)';
            iconClass = 'fa-user-slash';
        }

        data = (data || []).filter(u => typeof u === "string" && u.trim());

        // Filter
        if (filter) {
            data = data.filter(u => u.toLowerCase().includes(filter.toLowerCase()));
        }

        // Sort A-Z
        data.sort();

        // Header Count
        const header = document.createElement('div');
        header.className = "mb-4 text-sm text-slate-400 flex items-center justify-between";
        header.innerHTML = `<span>Menampilkan ${data.length} akun</span>`;
        container.appendChild(header);

        if (data.length === 0) {
            container.innerHTML += `
                <div class="text-center py-20 text-slate-600">
                    <i class="fa-solid ${iconClass} text-5xl mb-4 opacity-50"></i>
                    <p class="text-lg">${emptyMessage}</p>
                </div>
            `;
            return;
        }

        // Create Grid/Table
        const grid = document.createElement('div');
        grid.className = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4";

        data.forEach((username, index) => {
            const card = document.createElement('div');
            card.className = "reveal show hover-lift flex items-center justify-between p-4 bg-slate-800/100 border border-white/5 rounded-lg hover:border-cyan-400/50 transition-colors group";
            card.innerHTML = `
                <div class="flex items-center gap-3 overflow-hidden">
                    <span class="text-slate-500 text-xs font-mono w-6">#${index + 1}</span>
                    <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-500 to-pink-500 flex items-center justify-center text-xs font-bold text-white uppercase">
                        ${(username && username.length) ? username[0].toUpperCase() : '?'}
                    </div>
                    <span class="font-bold text-white truncate text-sm" title="${username}">${username}</span>
                </div>
                <a href="https://instagram.com/${username}" target="_blank" class="text-slate-500 hover:text-cyan-400 transition-colors">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </a>
            `;
            grid.appendChild(card);
        });

        container.appendChild(grid);
    }
};

// Start
document.addEventListener('DOMContentLoaded', () => {
    ui.init();
});
