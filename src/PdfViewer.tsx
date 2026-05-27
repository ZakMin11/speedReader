import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useReading } from './ReadingContext';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
).toString();

interface PdfViewerProps {
  onNavigateToReader: () => void;
  isSplitView: boolean;
  onToggleSplitView: () => void;
}

const THUMBNAIL_SCALE = 0.18;

const PdfViewer: React.FC<PdfViewerProps> = ({ onNavigateToReader, isSplitView, onToggleSplitView }) => {
    const [numPages, setNumPages] = useState<number>(0);
    const [scale, setScale] = useState<number>(1.5);
    const [error, setError] = useState<string | null>(null);
    const [isExtracting, setIsExtracting] = useState<boolean>(false);
    const [extractionProgress, setExtractionProgress] = useState<number>(0);
    const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

    const pdfDocumentRef = useRef<any>(null);
    const pdfContainerRef = useRef<HTMLDivElement>(null);
    const activeThumbRef = useRef<HTMLButtonElement | null>(null);

    // Single persistent Highlight instance, mutated via clear()/add().
    // Replacing the Highlight object on every word change leaves WebKit's
    // paint of the previous range stuck on screen.
    const highlightRef = useRef<any>(null);

    const getHighlight = useCallback(() => {
        if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null;
        if (!highlightRef.current) {
            highlightRef.current = new (window as any).Highlight();
            (CSS as any).highlights.set('sr-target', highlightRef.current);
        }
        return highlightRef.current;
    }, []);

    const applyHighlight = useCallback((range: Range) => {
        const h = getHighlight();
        if (!h) return;
        h.clear();
        h.add(range);
    }, [getHighlight]);

    const clearHighlight = useCallback(() => {
        highlightRef.current?.clear();
    }, []);

    const {
        setPageText,
        clearPageTexts,
        setCurrentWordIndex,
        setCurrentReadingPage,
        setTotalPages,
        pdfPath,
        setPdfPath,
        pageTexts,
        currentViewPage,
        setCurrentViewPage,
        pdfData: contextPdfData,
        setPdfData: setContextPdfData,
        setTargetWord,
        pdfSelectedTarget: selectedTargetWord,
        setPdfSelectedTarget: setSelectedTargetWord,
        targetWord,
    } = useReading();

    const [currentPage, setCurrentPage] = useState<number>(currentViewPage || 1);

    useEffect(() => {
        if (currentViewPage && currentViewPage !== currentPage) {
            setCurrentPage(currentViewPage);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        activeThumbRef.current?.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
        });
    }, [currentPage]);

    const fileData = useMemo(() => {
        if (!contextPdfData) return null;
        return { data: contextPdfData };
    }, [contextPdfData]);

    const handleFileSelect = async () => {
        const selected = await open({
            multiple: false,
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });

        if (selected && typeof selected === 'string') {
            try {
                const bytes = await readFile(selected);
                setContextPdfData(bytes);
                setPdfPath(selected);
                setCurrentPage(1);
                setCurrentViewPage(1);
                setError(null);
                clearPageTexts();
                setSelectedTargetWord(null);
                clearHighlight();
            } catch (err) {
                console.error('Error reading file:', err);
                setError('Failed to read the PDF file');
            }
        }
    };

    const reapplyHighlight = useCallback(() => {
        if (!selectedTargetWord || selectedTargetWord.page !== currentPage) {
            clearHighlight();
            return;
        }
        const container = pdfContainerRef.current;
        if (!container) return;
        const textLayer = container.querySelector('.react-pdf__Page__textContent');
        if (!textLayer) return;

        const needle = selectedTargetWord.word.toLowerCase();
        const wordRe = new RegExp(
            `(?<![a-zA-Z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9])`,
            'ig'
        );

        let found = 0;
        for (const span of Array.from(textLayer.querySelectorAll('span'))) {
            const textNode = span.firstChild;
            if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
            const text = textNode.textContent ?? '';
            wordRe.lastIndex = 0;
            let m;
            while ((m = wordRe.exec(text)) !== null) {
                if (found === selectedTargetWord.occurrence) {
                    try {
                        const range = document.createRange();
                        range.setStart(textNode, m.index);
                        range.setEnd(textNode, m.index + m[0].length);
                        applyHighlight(range);
                    } catch (_) {}
                    return;
                }
                found++;
            }
        }
    }, [selectedTargetWord, currentPage, applyHighlight, clearHighlight]);

    // Manual-selection highlight: MutationObserver with 80ms debounce so the
    // highlight persists after react-pdf re-renders the text layer.
    // Disabled in split view — the live highlight below takes over there.
    useEffect(() => {
        if (isSplitView) return;
        if (!selectedTargetWord || !pdfContainerRef.current) {
            if (!selectedTargetWord) clearHighlight();
            return;
        }

        let debounce: ReturnType<typeof setTimeout>;
        const schedule = () => {
            clearTimeout(debounce);
            debounce = setTimeout(reapplyHighlight, 80);
        };

        const observer = new MutationObserver(schedule);
        observer.observe(pdfContainerRef.current, { childList: true, subtree: true });

        schedule();

        return () => {
            observer.disconnect();
            clearTimeout(debounce);
        };
    }, [isSplitView, selectedTargetWord, currentPage, reapplyHighlight, clearHighlight]);

    const goToPage = useCallback((pageNum: number) => {
        setCurrentPage(pageNum);
        setCurrentViewPage(pageNum);
    }, [setCurrentViewPage]);

    // ─── Split-view live highlight ────────────────────────────────────────────────
    // We deliberately avoid React state for each word update — every word change
    // would cause a re-render chain and the 80ms debounce makes the highlight
    // visibly lag. Instead: store the pre-computed target in a ref, call the DOM
    // function directly (no debounce), and let a short-debounced MutationObserver
    // handle the only case that needs a retry: a page transition where the text
    // layer hasn't painted yet.

    const liveHighlightRef = useRef<{ word: string; page: number; occurrence: number } | null>(null);

    // Same DOM walk as reapplyHighlight but reads from liveHighlightRef (a ref,
    // not state) so it can be called without triggering renders.
    const doLiveHighlight = useCallback(() => {
        const target = liveHighlightRef.current;
        if (!target || target.page !== currentPage) { clearHighlight(); return; }
        const container = pdfContainerRef.current;
        if (!container) return;
        const textLayer = container.querySelector('.react-pdf__Page__textContent');
        if (!textLayer) return;

        const needle = target.word.toLowerCase();
        const wordRe = new RegExp(
            `(?<![a-zA-Z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9])`,
            'ig'
        );
        let found = 0;
        for (const span of Array.from(textLayer.querySelectorAll('span'))) {
            const textNode = span.firstChild;
            if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
            const text = textNode.textContent ?? '';
            wordRe.lastIndex = 0;
            let m;
            while ((m = wordRe.exec(text)) !== null) {
                if (found === target.occurrence) {
                    try {
                        const range = document.createRange();
                        range.setStart(textNode, m.index);
                        range.setEnd(textNode, m.index + m[0].length);
                        applyHighlight(range);
                    } catch (_) {}
                    return;
                }
                found++;
            }
        }
        clearHighlight();
    }, [currentPage, applyHighlight, clearHighlight]);

    // Fires on every word change when in split view.
    useEffect(() => {
        if (!isSplitView || !targetWord) {
            liveHighlightRef.current = null;
            if (!isSplitView) clearHighlight();
            return;
        }

        // Navigate to the reading page when it changes.
        if (targetWord.pageNumber !== currentPage) {
            goToPage(targetWord.pageNumber);
            // Text layer isn't ready yet — the MutationObserver below retries
            // once the new page paints.
        }

        // Pre-compute occurrence from wordIndexOnPage using the extracted text,
        // then store in ref so doLiveHighlight can be called without state.
        const pageTextData = pageTexts.get(targetWord.pageNumber);
        if (pageTextData) {
            const { text } = pageTextData;
            const needle = targetWord.word;
            const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const tokenRe = /\S+/g;
            let tokenMatch;
            let tokenIdx = 0;
            let charPos = text.length;
            while ((tokenMatch = tokenRe.exec(text)) !== null) {
                if (tokenIdx === targetWord.wordIndexOnPage) { charPos = tokenMatch.index; break; }
                tokenIdx++;
            }
            const wordRe = new RegExp(`(?<![a-zA-Z0-9])${escapedNeedle}(?![a-zA-Z0-9])`, 'ig');
            let occurrence = 0;
            let m;
            while ((m = wordRe.exec(text)) !== null && m.index < charPos) occurrence++;

            liveHighlightRef.current = { word: needle, page: targetWord.pageNumber, occurrence };
        } else {
            // Page text not loaded yet — clear so the stale previous target
            // isn't re-applied by doLiveHighlight or the MutationObserver.
            liveHighlightRef.current = null;
            clearHighlight();
        }

        // Apply immediately — only the page-transition path needs the retry below.
        if (targetWord.pageNumber === currentPage) doLiveHighlight();

    }, [isSplitView, targetWord, currentPage, pageTexts, goToPage, doLiveHighlight, clearHighlight]);

    // Short-debounced MutationObserver for the page-transition case: the reading
    // page just changed, the new text layer is loading — retry until it's ready.
    useEffect(() => {
        if (!isSplitView || !pdfContainerRef.current) return;
        let debounce: ReturnType<typeof setTimeout>;
        const schedule = () => { clearTimeout(debounce); debounce = setTimeout(doLiveHighlight, 16); };
        const observer = new MutationObserver(schedule);
        observer.observe(pdfContainerRef.current, { childList: true, subtree: true });
        return () => { observer.disconnect(); clearTimeout(debounce); };
    }, [isSplitView, doLiveHighlight]);

    const handleWordSelection = useCallback(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;
        const raw = selection.toString().trim();
        if (!raw) return;
        const firstToken = raw.split(/\s+/)[0];
        const clean = firstToken.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
        if (!clean) return;
        if (selection.rangeCount === 0) return;

        const selRange = selection.getRangeAt(0);

        let occurrence = 0;
        let foundOccurrence = false;
        const container = pdfContainerRef.current;
        if (container) {
            const textLayer = container.querySelector('.react-pdf__Page__textContent');
            if (textLayer) {
                // 'ig' flag + exec loop so we count every match, not just per-span.
                const wordRe = new RegExp(
                    `(?<![a-zA-Z0-9])${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9])`,
                    'ig'
                );
                for (const span of Array.from(textLayer.querySelectorAll('span'))) {
                    const textNode = span.firstChild;
                    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
                    const text = textNode.textContent ?? '';
                    const isClicked = textNode === selRange.startContainer || span === selRange.startContainer;
                    // For the clicked span, only count matches that START before the cursor.
                    // For earlier spans, count all matches.
                    const limit = isClicked ? selRange.startOffset : text.length;
                    wordRe.lastIndex = 0;
                    let m;
                    while ((m = wordRe.exec(text)) !== null && m.index < limit) {
                        occurrence++;
                    }
                    if (isClicked) {
                        foundOccurrence = true;
                        break;
                    }
                }
            }
        }
        if (!foundOccurrence) occurrence = 0;

        applyHighlight(selRange.cloneRange());

        setSelectedTargetWord({ word: clean, page: currentPage, occurrence });
        selection.removeAllRanges();
    }, [currentPage, applyHighlight]);

    const extractPageText = useCallback(async (pageNumber: number): Promise<string> => {
        if (!pdfDocumentRef.current) throw new Error('PDF document not loaded');
        const page = await pdfDocumentRef.current.getPage(pageNumber);
        const textContent = await page.getTextContent();
        return textContent.items
            .map((item: any) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }, []);

    const extractInitialPages = useCallback(async (startPage: number = 1) => {
        if (!pdfDocumentRef.current) return;

        const effectiveStart = selectedTargetWord ? selectedTargetWord.page : startPage;

        if (selectedTargetWord) {
            clearPageTexts();
        }

        setIsExtracting(true);
        setError(null);
        setExtractionProgress(0);

        try {
            const totalPagesToExtract = Math.min(2, numPages - effectiveStart + 1);
            const extractedTexts = new Map<number, string>();

            for (let i = 0; i < totalPagesToExtract; i++) {
                const pageNum = effectiveStart + i;
                const text = await extractPageText(pageNum);
                setPageText(pageNum, text);
                extractedTexts.set(pageNum, text);
                setExtractionProgress(((i + 1) / totalPagesToExtract) * 100);
            }

            setCurrentReadingPage(effectiveStart);

            if (selectedTargetWord) {
                const targetPageText = extractedTexts.get(selectedTargetWord.page);
                if (targetPageText) {
                    // Use the same character-level regex that handleWordSelection used
                    // so occurrence indices are consistent between the two.
                    const needle = selectedTargetWord.word;
                    const wordRe = new RegExp(
                        `(?<![a-zA-Z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9])`,
                        'ig'
                    );

                    let matchCount = 0;
                    let idxOnPage = 0;
                    let m;
                    while ((m = wordRe.exec(targetPageText)) !== null) {
                        if (matchCount === selectedTargetWord.occurrence) {
                            // Convert char position to word index within this page.
                            const textBefore = targetPageText.substring(0, m.index);
                            idxOnPage = textBefore.split(/\s+/).filter(w => w.length > 0).length;
                            break;
                        }
                        matchCount++;
                    }

                    setCurrentWordIndex(idxOnPage);
                    setTargetWord({
                        word: selectedTargetWord.word,
                        pageNumber: selectedTargetWord.page,
                        wordIndexOnPage: idxOnPage,
                    });
                }
            }

            onNavigateToReader();
        } catch (err) {
            console.error('Error extracting pages:', err);
            setError('Failed to extract text from PDF');
        } finally {
            setIsExtracting(false);
            setExtractionProgress(0);
        }
    }, [extractPageText, numPages, setPageText, setCurrentReadingPage, onNavigateToReader, selectedTargetWord, setCurrentWordIndex, setTargetWord, clearPageTexts]);

    const preloadNextPage = useCallback(async (pageNumber: number) => {
        if (!pdfDocumentRef.current) return;
        if (pageNumber > numPages || pageTexts.has(pageNumber)) return;

        try {
            const text = await extractPageText(pageNumber);
            setPageText(pageNumber, text);
        } catch (err) {
            console.error(`Error preloading page ${pageNumber}:`, err);
        }
    }, [numPages, pageTexts, extractPageText, setPageText]);

    useEffect(() => {
        (window as any).preloadNextPage = preloadNextPage;
        return () => { delete (window as any).preloadNextPage; };
    }, [preloadNextPage]);

    const handleDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
        setTotalPages(numPages);
        setError(null);
    };

    const handleDocumentError = (err: any) => {
        setError(`Failed to load PDF: ${err.message || 'Unknown error'}`);
    };

    const goToNextPage = () => {
        if (currentPage < numPages) {
            goToPage(currentPage + 1);
        }
    };

    const goToPreviousPage = () => {
        if (currentPage > 1) {
            goToPage(currentPage - 1);
        }
    };

    const handleZoomIn = () => setScale(prev => Math.min(3, prev + 0.25));
    const handleZoomOut = () => setScale(prev => Math.max(0.5, prev - 0.25));

    const startReadingFromCurrentPage = () => {
        // If pages are already loaded and no new target word was picked, resume
        // in place — skip extraction so currentWordIndex isn't touched.
        if (pageTexts.size > 0 && !selectedTargetWord) {
            onNavigateToReader();
            return;
        }
        extractInitialPages(currentPage);
    };

    return (
        <div className="pdf-viewer">
            <style>{`
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

                .pdf-viewer {
                    width: 100%;
                    height: 100vh;
                    background: #111;
                    display: flex;
                    flex-direction: column;
                    font-family: inherit;
                    color: #c8c8c8;
                    -webkit-font-smoothing: antialiased;
                }

                .header {
                    padding: 0 18px;
                    height: 44px;
                    background: #181818;
                    border-bottom: 1px solid #252525;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 12px;
                    flex-shrink: 0;
                }

                .title {
                    font-size: 13px;
                    font-weight: 500;
                    color: #888;
                    letter-spacing: 0.01em;
                }

                .header-actions {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                }

                .btn {
                    padding: 5px 12px;
                    background: #1e1e1e;
                    border: 1px solid #2e2e2e;
                    border-radius: 4px;
                    color: #c8c8c8;
                    font-size: 12px;
                    font-family: inherit;
                    cursor: pointer;
                    transition: background 0.12s, border-color 0.12s;
                    white-space: nowrap;
                }

                .btn:hover {
                    background: #262626;
                    border-color: #3a3a3a;
                }

                .btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }

                .btn.primary {
                    background: #1e1e1e;
                    border-color: #363636;
                    color: #aaa;
                }

                .btn.primary:hover:not(:disabled) {
                    background: #262626;
                    border-color: #484848;
                    color: #c8c8c8;
                }

                .btn.success {
                    background: #c8c8c8;
                    border-color: #c8c8c8;
                    color: #111;
                    font-weight: 600;
                }

                .btn.success:hover:not(:disabled) {
                    background: #b8b8b8;
                    border-color: #b8b8b8;
                }

                .sidebar-toggle {
                    width: 30px;
                    height: 30px;
                    background: #1e1e1e;
                    border: 1px solid #2e2e2e;
                    border-radius: 4px;
                    color: #c8c8c8;
                    font-size: 14px;
                    cursor: pointer;
                    transition: background 0.12s, border-color 0.12s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }

                .sidebar-toggle:hover {
                    background: #262626;
                    border-color: #3a3a3a;
                }

                .content {
                    flex: 1;
                    display: flex;
                    min-height: 0;
                    overflow: hidden;
                }

                .sidebar {
                    width: 220px;
                    background: #151515;
                    border-right: 1px solid #252525;
                    overflow-y: auto;
                    flex-shrink: 0;
                    padding: 12px 10px;
                    transition: width 0.18s ease, padding 0.18s ease, border-color 0.18s ease;
                }

                .sidebar.closed {
                    width: 0;
                    padding: 0;
                    border-right-color: transparent;
                    overflow: hidden;
                }

                .sidebar-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 10px;
                    padding: 0 2px;
                }

                .sidebar-title {
                    font-size: 11px;
                    color: #777;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                }

                .thumbnail-list {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }

                .thumbnail-btn {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 6px;
                    width: 100%;
                    padding: 8px;
                    background: #1b1b1b;
                    border: 1px solid #2a2a2a;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: background 0.12s, border-color 0.12s;
                }

                .thumbnail-btn:hover {
                    background: #222;
                    border-color: #3a3a3a;
                }

                .thumbnail-btn.active {
                    border-color: #8a8a8a;
                    background: #242424;
                }

                .thumbnail-btn :global(canvas),
                .thumbnail-btn canvas {
                    max-width: 100%;
                    height: auto !important;
                    display: block;
                }

                .thumbnail-page-label {
                    font-size: 11px;
                    color: #777;
                    font-variant-numeric: tabular-nums;
                }

                .main-pane {
                    flex: 1;
                    min-width: 0;
                    min-height: 0;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    padding: 2rem;
                }

                .pdf-container {
                    box-shadow: 0 2px 12px rgba(0,0,0,0.6);
                    overflow: hidden;
                    background: #fff;
                    max-width: 100%;
                }

                .controls {
                    position: fixed;
                    bottom: 1.5rem;
                    left: 50%;
                    transform: translateX(-50%);
                    background: #181818;
                    border: 1px solid #252525;
                    border-radius: 6px;
                    padding: 8px 16px;
                    display: flex;
                    align-items: center;
                    gap: 1.25rem;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
                    z-index: 1000;
                }

                .nav-controls {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .nav-btn {
                    width: 32px;
                    height: 32px;
                    background: #1e1e1e;
                    border: 1px solid #2e2e2e;
                    border-radius: 4px;
                    color: #c8c8c8;
                    font-size: 1.1rem;
                    cursor: pointer;
                    transition: background 0.12s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .nav-btn:hover:not(:disabled) {
                    background: #262626;
                }

                .nav-btn:disabled {
                    opacity: 0.25;
                    cursor: not-allowed;
                }

                .page-info {
                    font-size: 12px;
                    color: #555;
                    min-width: 72px;
                    text-align: center;
                    font-variant-numeric: tabular-nums;
                }

                .zoom-controls {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding-left: 1.25rem;
                    border-left: 1px solid #252525;
                }

                .zoom-btn {
                    width: 28px;
                    height: 28px;
                    background: #1e1e1e;
                    border: 1px solid #2e2e2e;
                    border-radius: 4px;
                    color: #c8c8c8;
                    font-size: 0.9rem;
                    cursor: pointer;
                    transition: background 0.12s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .zoom-btn:hover {
                    background: #262626;
                }

                .zoom-level {
                    font-size: 11px;
                    color: #555;
                    min-width: 44px;
                    text-align: center;
                    font-variant-numeric: tabular-nums;
                }

                .empty-state {
                    text-align: center;
                    padding: 4rem 2rem;
                    width: 100%;
                }

                .empty-icon {
                    font-size: 3rem;
                    margin-bottom: 1.5rem;
                    opacity: 0.15;
                }

                .empty-title {
                    font-size: 1.25rem;
                    font-weight: 600;
                    margin-bottom: 0.5rem;
                    color: #c8c8c8;
                }

                .empty-description {
                    font-size: 0.875rem;
                    color: #555;
                    margin-bottom: 2rem;
                    line-height: 1.6;
                }

                .error-message {
                    background: #1e1212;
                    border: 1px solid #3a2020;
                    color: #cc8888;
                    padding: 0.75rem 1rem;
                    border-radius: 4px;
                    margin-bottom: 1.5rem;
                    font-size: 13px;
                }

                .loading-message {
                    background: #181818;
                    border: 1px solid #2a2a2a;
                    color: #888;
                    padding: 0.75rem 1rem;
                    border-radius: 4px;
                    margin-bottom: 1.5rem;
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    font-size: 13px;
                }

                .spinner {
                    width: 16px;
                    height: 16px;
                    border: 2px solid #333;
                    border-top-color: #888;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                    flex-shrink: 0;
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                .progress-bar-container {
                    width: 100%;
                    max-width: 200px;
                    height: 3px;
                    background: #2a2a2a;
                    border-radius: 2px;
                    overflow: hidden;
                }

                .progress-bar-fill {
                    height: 100%;
                    background: #555;
                    transition: width 0.3s;
                }

                .target-pill {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    background: #1e1e1e;
                    border: 1px solid #363636;
                    border-radius: 4px;
                    padding: 4px 10px;
                    font-size: 11px;
                    color: #888;
                    max-width: 220px;
                    min-width: 0;
                }

                .target-pill-word {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    font-weight: 600;
                    color: #c8c8c8;
                }

                .target-pill-page {
                    flex-shrink: 0;
                    background: #2a2a2a;
                    border-radius: 3px;
                    padding: 1px 5px;
                    font-size: 10px;
                    color: #666;
                }

                .target-clear-btn {
                    flex-shrink: 0;
                    background: none;
                    border: none;
                    color: #555;
                    cursor: pointer;
                    font-size: 0.85rem;
                    padding: 0 2px;
                    line-height: 1;
                    transition: color 0.12s;
                    font-family: inherit;
                }

                .target-clear-btn:hover {
                    color: #c8c8c8;
                }

                .selection-hint {
                    font-size: 11px;
                    color: #333;
                    text-align: center;
                    padding: 6px 0 0;
                    pointer-events: none;
                    user-select: none;
                }

                ::highlight(sr-target) {
                    background-color: rgba(180, 180, 180, 0.45);
                    color: inherit;
                }
            `}</style>

            <div className="header">
                <div className="title">PDF Viewer</div>
                <div className="header-actions">
                    {selectedTargetWord && (
                        <div className="target-pill" title={`Start speed reading from "${selectedTargetWord.word}"`}>
                            <span className="target-pill-word">Start: "{selectedTargetWord.word}"</span>
                            <span className="target-pill-page">p.{selectedTargetWord.page}</span>
                            <button
                                className="target-clear-btn"
                                onClick={() => { setSelectedTargetWord(null); clearHighlight(); }}
                                title="Clear target word"
                                type="button"
                            >
                                ✕
                            </button>
                        </div>
                    )}

                    {fileData && (
                        <button
                            className="sidebar-toggle"
                            onClick={() => setIsSidebarOpen(prev => !prev)}
                            title={isSidebarOpen ? 'Hide page sidebar' : 'Show page sidebar'}
                            type="button"
                        >
                            ☰
                        </button>
                    )}

                    <button className="btn primary" onClick={handleFileSelect}>
                        {pdfPath ? 'Change PDF' : 'Open PDF'}
                    </button>

                    <button className="btn" onClick={onToggleSplitView} type="button">
                        {isSplitView ? 'Exit Split' : 'Split View'}
                    </button>

                    {fileData && (
                        <button
                            className="btn success"
                            onClick={startReadingFromCurrentPage}
                            disabled={isExtracting}
                        >
                            {isExtracting
                                ? 'Loading...'
                                : selectedTargetWord
                                    ? `Speed Read from "${selectedTargetWord.word}"`
                                    : pageTexts.size > 0
                                        ? 'Resume Reading'
                                        : `Speed Read — p.${currentPage}`}
                        </button>
                    )}
                </div>
            </div>

            <div className="content">
                {fileData && (
                    <aside className={`sidebar ${isSidebarOpen ? '' : 'closed'}`}>
                        <div className="sidebar-header">
                            <div className="sidebar-title">Pages</div>
                        </div>

                        <div className="thumbnail-list">
                            {Array.from({ length: numPages }, (_, i) => {
                                const pageNum = i + 1;
                                const isActive = pageNum === currentPage;

                                return (
                                    <button
                                        key={pageNum}
                                        ref={isActive ? activeThumbRef : null}
                                        className={`thumbnail-btn ${isActive ? 'active' : ''}`}
                                        onClick={() => goToPage(pageNum)}
                                        type="button"
                                    >
                                        <Document file={fileData}>
                                            <Page
                                                pageNumber={pageNum}
                                                scale={THUMBNAIL_SCALE}
                                                renderTextLayer={false}
                                                renderAnnotationLayer={false}
                                            />
                                        </Document>
                                        <div className="thumbnail-page-label">Page {pageNum}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </aside>
                )}

                <div className="main-pane">
                    {error && <div className="error-message">{error}</div>}

                    {isExtracting && (
                        <div className="loading-message">
                            <div className="spinner" />
                            <div>
                                <div>Extracting text from pages...</div>
                                <div className="progress-bar-container" style={{ marginTop: '8px' }}>
                                    <div className="progress-bar-fill" style={{ width: `${extractionProgress}%` }} />
                                </div>
                            </div>
                        </div>
                    )}

                    {!fileData ? (
                        <div className="empty-state">
                            <div className="empty-icon">—</div>
                            <h2 className="empty-title">No document open</h2>
                            <p className="empty-description">
                                Open a PDF, then double-click any word to set your start point
                            </p>
                        </div>
                    ) : (
                        <>
                            <div
                                className="pdf-container"
                                ref={pdfContainerRef}
                                onMouseUp={handleWordSelection}
                            >
                                <Document
                                    file={fileData}
                                    onLoadSuccess={(pdf) => {
                                        handleDocumentLoadSuccess({ numPages: pdf.numPages });
                                        pdfDocumentRef.current = pdf;
                                    }}
                                    onLoadError={handleDocumentError}
                                >
                                    <Page
                                        pageNumber={currentPage}
                                        scale={scale}
                                        renderTextLayer={true}
                                        renderAnnotationLayer={false}
                                    />
                                </Document>
                            </div>

                            <p className="selection-hint">
                                Double-click any word to set it as the speed-reading start point
                            </p>
                        </>
                    )}
                </div>
            </div>

            {contextPdfData && numPages > 0 && (
                <div className="controls">
                    <div className="nav-controls">
                        <button className="nav-btn" onClick={goToPreviousPage} disabled={currentPage <= 1} type="button">‹</button>
                        <div className="page-info">{currentPage} / {numPages}</div>
                        <button className="nav-btn" onClick={goToNextPage} disabled={currentPage >= numPages} type="button">›</button>
                    </div>
                    <div className="zoom-controls">
                        <button className="zoom-btn" onClick={handleZoomOut} type="button">−</button>
                        <div className="zoom-level">{Math.round(scale * 100)}%</div>
                        <button className="zoom-btn" onClick={handleZoomIn} type="button">+</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PdfViewer;