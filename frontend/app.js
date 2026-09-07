document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    
    const uploadPanel = document.getElementById('upload-panel');
    const processingPanel = document.getElementById('processing-panel');
    const viewBtn = document.getElementById('view-walkthrough-btn');

    viewBtn.addEventListener('click', () => {
        // Navigates directly to the fresh index.html with a timestamp to completely bypass browser caching
        window.location.href = '/viewer/index.html?v=' + new Date().getTime();
    });

    // Handle Drag & Drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    });

    const singleBtn = document.getElementById('single-btn');
    const singleFileInput = document.getElementById('single-file-input');
    const stagedPreview = document.getElementById('staged-preview');
    const stagedCount = document.getElementById('staged-count');
    const stagedList = document.getElementById('staged-list');
    const startUploadBtn = document.getElementById('start-upload-btn');

    let stagedFiles = [];

    singleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        singleFileInput.click();
    });

    singleFileInput.addEventListener('change', function() {
        if (this.files && this.files.length > 0) {
            addStagedFiles(Array.from(this.files));
            this.value = '';
        }
    });

    browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    fileInput.addEventListener('change', function() {
        if (this.files && this.files.length > 0) {
            addStagedFiles(Array.from(this.files));
            this.value = '';
        }
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files.length > 0) {
            addStagedFiles(Array.from(files));
        }
    });

    function addStagedFiles(newFiles) {
        newFiles.forEach(f => {
            if (!stagedFiles.some(existing => existing.name === f.name && existing.size === f.size)) {
                stagedFiles.push(f);
            }
        });
        stagedFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        renderStaged();
    }

    function renderStaged() {
        if (stagedFiles.length === 0) {
            stagedPreview.classList.add('hidden');
            return;
        }
        stagedPreview.classList.remove('hidden');
        stagedCount.innerText = `${stagedFiles.length} Photo${stagedFiles.length > 1 ? 's' : ''} Staged (Added 1-by-1 or batch)`;
        
        stagedList.innerHTML = '';
        stagedFiles.forEach((file, index) => {
            const badge = document.createElement('div');
            badge.style.cssText = 'background: rgba(99, 102, 241, 0.2); border: 1px solid rgba(99, 102, 241, 0.4); border-radius: 8px; padding: 4px 10px; font-size: 11px; color: white; display: flex; align-items: center; gap: 6px;';
            badge.innerHTML = `<span>📸 ${file.name}</span> <span style="cursor:pointer; color:#f87171; font-weight:bold;" data-index="${index}">✕</span>`;
            
            badge.querySelector('span[data-index]').addEventListener('click', (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'), 10);
                stagedFiles.splice(idx, 1);
                renderStaged();
            });

            stagedList.appendChild(badge);
        });
    }

    startUploadBtn.addEventListener('click', () => {
        if (stagedFiles.length > 0) {
            handleFiles(stagedFiles);
        }
    });

    async function handleFiles(files) {
        if (files.length === 0) return;
        
        // Transition UI to uploading state
        uploadPanel.style.transform = 'scale(0.95)';
        uploadPanel.style.opacity = '0';
        
        setTimeout(() => {
            uploadPanel.classList.add('hidden');
            processingPanel.classList.remove('hidden');
        }, 400);

        const step1 = document.getElementById('step-1');
        const step2 = document.getElementById('step-2');

        step1.querySelector('h3').innerText = "Uploading YOUR Photos...";
        step1.querySelector('p').innerText = "Saving files to local AI server...";

        try {
            // ACTUALLY UPLOAD THE FILES
            const formData = new FormData();
            for (let i = 0; i < files.length; i++) {
                formData.append('files', files[i]);
            }

            const uploadRes = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            const uploadData = await uploadRes.json();

            if (uploadRes.ok) {
                step1.classList.remove('active');
                step1.classList.add('completed');
                step1.querySelector('.step-indicator').innerHTML = '✓';
                
                step2.classList.add('active');

                // Trigger Local Pipeline
                const res = await fetch('/api/walkthrough/generate', { method: 'POST' });
                
                if (res.ok) {
                    // Start Polling
                    pollStatus();
                } else {
                    alert("3D Processing Failed to Start. Please check the backend console for errors.");
                }
            } else {
                alert("Upload Failed: " + uploadData.detail);
                window.location.reload();
            }

        } catch (err) {
            console.error("API Error", err);
            alert("Failed to upload photos. Is the backend running?");
            window.location.reload();
        }
    }

    async function pollStatus() {
        const step2 = document.getElementById('step-2');
        const step3 = document.getElementById('step-3');
        
        try {
            const res = await fetch('/api/walkthrough/status?t=' + new Date().getTime());
            const data = await res.json();
            
            if (data.step === 2) {
                step2.classList.add('active');
                step2.querySelector('h3').innerText = "COLMAP Processing";
                step2.querySelector('p').innerText = data.message || "Processing photos locally to build the 3D skeleton...";
                setTimeout(pollStatus, 2000);
            } else if (data.step === 3) {
                step2.classList.remove('active');
                step2.classList.add('completed');
                step2.querySelector('.step-indicator').innerHTML = '✓';
                
                step3.classList.add('active');
                step3.querySelector('h3').innerText = "3D Gaussian Splatting";
                step3.querySelector('p').innerText = data.message || "Training neural radiance fields natively...";
                setTimeout(pollStatus, 2000);
            } else if (data.step === 4) {
                step2.classList.remove('active');
                step2.classList.add('completed');
                step2.querySelector('.step-indicator').innerHTML = '✓';
                
                step3.classList.remove('active');
                step3.classList.add('completed');
                step3.querySelector('.step-indicator').innerHTML = '✓';
                
                viewBtn.classList.remove('hidden');
            } else if (data.step === -1) {
                alert("Processing Failed: " + data.message);
            } else {
                setTimeout(pollStatus, 2000);
            }
        } catch (err) {
            console.error("Polling Error", err);
            setTimeout(pollStatus, 5000);
        }
    }
});
