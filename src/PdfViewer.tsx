import React, { useState, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
// Updated CSS imports for react-pdf v7+
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { convertFileSrc } from '@tauri-apps/api/core';
// Set up PDF.js worker from node_modules
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
).toString();

const PdfViewer: React.FC = () => {
    const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
    const [pdfPath, setPdfPath] = useState<string | null>(null);
    const [numPages, setNumPages] = useState<number>(0);
    const [currentPage, setCurrentPage] = useState<number>(1);
    const [scale, setScale] = useState<number>(1.5);
    const [error, setError] = useState<string | null>(null);

    // Memoize the file object to prevent unnecessary reloads
    const fileData = useMemo(() => {
        if (!pdfData) return null;
        return { data: pdfData };
    }, [pdfData]);

    const handleFileSelect = async () => {
        console.log('opening file dialog');
        const selected = await open({
            multiple: false,
            filters: [{
                name: 'PDF',
                extensions: ['pdf']
            }]
        });

        console.log('url selected: ', selected);
        if (selected && typeof selected === 'string') {
            try {
                const bytes = await readFile(selected);
                setPdfData(bytes);
                setPdfPath(selected);
                setCurrentPage(1);
                setError(null);
            } catch (err) {
                console.error('Error reading file:', err);
                setError('Failed to read the PDF file');
            }
        }
    };

    const handleDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        console.log('PDF loaded successfully with', numPages, 'pages');
        setNumPages(numPages);
        setError(null);
    };

    const handleDocumentError = (error: any) => {
        console.error('PDF loading error:', error);
        setError(`Failed to load PDF: ${error.message || 'Unknown error'}`);
    };

    const goToNextPage = () => {
        console.log('Next page clicked, current:', currentPage, 'total:', numPages);
        if (currentPage < numPages) {
            setCurrentPage(currentPage + 1);
        }
    };

    const goToPreviousPage = () => {
        console.log('Previous page clicked, current:', currentPage);
        if (currentPage > 1) {
            setCurrentPage(currentPage - 1);
        }
    };

    const handleZoomIn = () => {
        console.log('Zoom in clicked, current scale:', scale);
        setScale(prev => Math.min(3, prev + 0.25));
    };

    const handleZoomOut = () => {
        console.log('Zoom out clicked, current scale:', scale);
        setScale(prev => Math.max(0.5, prev - 0.25));
    };

    return (
        <div className="pdf-viewer">
            <style>{`
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                .pdf-viewer {
                    width: 100%;
                    height: 100vh;
                    background: #1a1a1a;
                    display: flex;
                    flex-direction: column;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    color: #e0e0e0;
                }

                .header {
                    padding: 1rem 2rem;
                    background: #242424;
                    border-bottom: 1px solid #333;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .title {
                    font-size: 1.25rem;
                    font-weight: 600;
                    color: #fff;
                }

                .btn {
                    padding: 0.5rem 1rem;
                    background: #3a3a3a;
                    border: 1px solid #555;
                    border-radius: 6px;
                    color: #e0e0e0;
                    font-size: 0.875rem;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .btn:hover {
                    background: #4a4a4a;
                    border-color: #666;
                }

                .btn.primary {
                    background: #0066cc;
                    border-color: #0066cc;
                    color: #fff;
                }

                .btn.primary:hover {
                    background: #0052a3;
                }

                .content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    padding: 2rem;
                    overflow-y: auto;
                }

                .pdf-container {
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    border-radius: 4px;
                    overflow: hidden;
                    background: #fff;
                }

                .controls {
                    position: fixed;
                    bottom: 2rem;
                    left: 50%;
                    transform: translateX(-50%);
                    background: #242424;
                    border: 1px solid #333;
                    border-radius: 8px;
                    padding: 0.75rem 1.5rem;
                    display: flex;
                    align-items: center;
                    gap: 1.5rem;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                }

                .nav-controls {
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                }

                .nav-btn {
                    width: 36px;
                    height: 36px;
                    background: #3a3a3a;
                    border: 1px solid #555;
                    border-radius: 6px;
                    color: #e0e0e0;
                    font-size: 1.25rem;
                    cursor: pointer;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .nav-btn:hover:not(:disabled) {
                    background: #4a4a4a;
                    border-color: #666;
                }

                .nav-btn:disabled {
                    opacity: 0.3;
                    cursor: not-allowed;
                }

                .page-info {
                    font-size: 0.875rem;
                    color: #999;
                    min-width: 80px;
                    text-align: center;
                }

                .zoom-controls {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding-left: 1.5rem;
                    border-left: 1px solid #333;
                }

                .zoom-btn {
                    width: 32px;
                    height: 32px;
                    background: #3a3a3a;
                    border: 1px solid #555;
                    border-radius: 6px;
                    color: #e0e0e0;
                    font-size: 1rem;
                    cursor: pointer;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .zoom-btn:hover {
                    background: #4a4a4a;
                }

                .zoom-level {
                    font-size: 0.75rem;
                    color: #999;
                    min-width: 48px;
                    text-align: center;
                }

                .empty-state {
                    text-align: center;
                    padding: 4rem 2rem;
                }

                .empty-icon {
                    font-size: 4rem;
                    margin-bottom: 1.5rem;
                    opacity: 0.3;
                }

                .empty-title {
                    font-size: 1.5rem;
                    font-weight: 600;
                    margin-bottom: 0.75rem;
                    color: #fff;
                }

                .empty-description {
                    font-size: 1rem;
                    color: #999;
                    margin-bottom: 2rem;
                    line-height: 1.6;
                }

                .error-message {
                    background: #7c2020;
                    border: 1px solid #c43a3a;
                    color: #ff9999;
                    padding: 1rem;
                    border-radius: 6px;
                    margin-bottom: 2rem;
                }
            `}</style>

            <div className="header">
                <div className="title">PDF Viewer</div>
                <button className="btn primary" onClick={handleFileSelect}>
                    {pdfPath ? 'Change PDF' : 'Open PDF'}
                </button>
            </div>

            <div className="content">
                {error && (
                    <div className="error-message">
                        {error}
                    </div>
                )}
                {!fileData ? (
                    <div className="empty-state">
                        <div className="empty-icon">📄</div>
                        <h2 className="empty-title">No PDF Loaded</h2>
                        <p className="empty-description">
                            Click the button above to open a PDF file
                        </p>
                    </div>
                ) : (
                    <div className="pdf-container">
                        <Document
                            file={fileData}
                            onLoadSuccess={handleDocumentLoadSuccess}
                            onError={handleDocumentError}
                        >
                            <Page
                                pageNumber={currentPage}
                                scale={scale}
                                renderTextLayer={true}
                                renderAnnotationLayer={false}
                            />
                        </Document>
                    </div>
                )}
            </div>

            {pdfData && numPages > 0 && (
                <div className="controls">
                    <div className="nav-controls">
                        <button
                            className="nav-btn"
                            onClick={goToPreviousPage}
                            disabled={currentPage <= 1}
                            type="button"
                        >
                            ‹
                        </button>
                        <div className="page-info">
                            {currentPage} / {numPages}
                        </div>
                        <button
                            className="nav-btn"
                            onClick={goToNextPage}
                            disabled={currentPage >= numPages}
                            type="button"
                        >
                            ›
                        </button>
                    </div>
                    
                    <div className="zoom-controls">
                        <button
                            className="zoom-btn"
                            onClick={handleZoomOut}
                            type="button"
                        >
                            −
                        </button>
                        <div className="zoom-level">{Math.round(scale * 100)}%</div>
                        <button
                            className="zoom-btn"
                            onClick={handleZoomIn}
                            type="button"
                        >
                            +
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PdfViewer;