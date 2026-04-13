import React, { useState } from 'react';
import { ReadingProvider } from './ReadingContext';
import PdfViewer from './PdfViewer';
import SpeedReader from './SpeedReader';

type View = 'pdf' | 'reader';

function App() {
  const [currentView, setCurrentView] = useState<View>('pdf');

  return (
    <ReadingProvider>
      {/*
        Both components are always mounted so that PdfViewer's pdfDocumentRef
        stays valid while SpeedReader is active. This allows background page
        preloading to work for end-to-end reading. CSS display:none hides the
        inactive view without destroying its state.
      */}
      <div style={{ display: currentView === 'pdf' ? 'block' : 'none', height: '100vh' }}>
        <PdfViewer onNavigateToReader={() => setCurrentView('reader')} />
      </div>
      <div style={{ display: currentView === 'reader' ? 'block' : 'none', height: '100vh' }}>
        <SpeedReader
          onNavigateToPdf={() => setCurrentView('pdf')}
          isActive={currentView === 'reader'}
        />
      </div>
    </ReadingProvider>
  );
}

export default App;
