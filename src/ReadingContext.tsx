import React, { createContext, useContext, useState, ReactNode } from 'react';

interface PageText {
  pageNumber: number;
  text: string;
  wordCount: number;
}

// Persists across view switches — both PdfViewer and SpeedReader reference this.
export interface TargetWordData {
  word: string;          // cleaned word text (no surrounding punctuation)
  pageNumber: number;    // PDF page where the word was selected
  wordIndexOnPage: number; // 0-based index within that page's word list (-1 = not yet resolved)
}

interface ReadingContextType {
  // Page-based text storage
  pageTexts: Map<number, PageText>;
  setPageText: (pageNumber: number, text: string) => void;
  clearPageTexts: () => void;

  // Reading position
  currentWordIndex: number;
  setCurrentWordIndex: (index: number | ((prev: number) => number)) => void;
  currentReadingPage: number;
  setCurrentReadingPage: (page: number) => void;

  // PDF info
  currentViewPage: number;
  setCurrentViewPage: (page: number) => void;
  totalPages: number;
  setTotalPages: (pages: number) => void;
  pdfPath: string | null;
  setPdfPath: (path: string | null) => void;
  pdfData: Uint8Array | null;
  setPdfData: (data: Uint8Array | null) => void;

  // Target word bookmark — persists when switching between views
  targetWord: TargetWordData | null;
  setTargetWord: (data: TargetWordData | null) => void;

  // Get combined text for current and next pages
  getCombinedText: () => string;
  getAllWords: () => string[];
}

const ReadingContext = createContext<ReadingContextType | undefined>(undefined);

export const ReadingProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [pageTexts, setPageTexts] = useState<Map<number, PageText>>(new Map());
  const [currentWordIndex, setCurrentWordIndex] = useState<number>(0);
  const [currentReadingPage, setCurrentReadingPage] = useState<number>(1);
  const [currentViewPage, setCurrentViewPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [targetWord, setTargetWord] = useState<TargetWordData | null>(null);

  const setPageText = (pageNumber: number, text: string) => {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    setPageTexts(prev => {
      const newMap = new Map(prev);
      newMap.set(pageNumber, {
        pageNumber,
        text,
        wordCount: words.length
      });
      return newMap;
    });
  };

  const clearPageTexts = () => {
    setPageTexts(new Map());
    setCurrentWordIndex(0);
    setCurrentReadingPage(1);
  };

  const getCombinedText = (): string => {
    const texts: string[] = [];
    const loadedPageNumbers = Array.from(pageTexts.keys()).sort((a, b) => a - b);
    for (const pageNum of loadedPageNumbers) {
      const pageText = pageTexts.get(pageNum);
      if (pageText) texts.push(pageText.text);
    }
    return texts.join(' ');
  };

  const getAllWords = (): string[] => {
    return getCombinedText().split(/\s+/).filter(w => w.length > 0);
  };

  return (
    <ReadingContext.Provider
      value={{
        pageTexts,
        setPageText,
        clearPageTexts,
        currentWordIndex,
        setCurrentWordIndex,
        currentReadingPage,
        setCurrentReadingPage,
        currentViewPage,
        setCurrentViewPage,
        totalPages,
        setTotalPages,
        pdfPath,
        setPdfPath,
        pdfData,
        setPdfData,
        targetWord,
        setTargetWord,
        getCombinedText,
        getAllWords,
      }}
    >
      {children}
    </ReadingContext.Provider>
  );
};

export const useReading = () => {
  const context = useContext(ReadingContext);
  if (context === undefined) {
    throw new Error('useReading must be used within a ReadingProvider');
  }
  return context;
};
