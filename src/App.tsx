import React, { useState } from 'react';
import { ReadingProvider } from './ReadingContext';
import PdfViewer from './PdfViewer';
import SpeedReader from './SpeedReader';

type View = 'pdf' | 'reader';

function App() {
  const [currentView, setCurrentView] = useState<View>('pdf');
  const [isSplitView, setIsSplitView] = useState(false);
  const toggleSplitView = () => setIsSplitView(v => !v);

  return (
    <ReadingProvider>
      {/*
        Both components are always mounted so that PdfViewer's pdfDocumentRef
        stays valid while SpeedReader is active. This allows background page
        preloading to work for end-to-end reading. In split view both are
        visible side-by-side; in single view CSS display:none hides the inactive
        one without destroying its state.
      */}
      <div style={{ display: isSplitView ? 'flex' : 'block', height: '100vh' }}>
        <div style={{
          flex: isSplitView ? 1 : undefined,
          height: '100%',
          display: isSplitView ? 'block' : (currentView === 'pdf' ? 'block' : 'none'),
          minWidth: 0,
          borderRight: isSplitView ? '1px solid #252525' : undefined,
          overflow: 'hidden',
        }}>
          <PdfViewer
            onNavigateToReader={() => setCurrentView('reader')}
            isSplitView={isSplitView}
            onToggleSplitView={toggleSplitView}
          />
        </div>
        <div style={{
          flex: isSplitView ? 1 : undefined,
          height: '100%',
          display: isSplitView ? 'block' : (currentView === 'reader' ? 'block' : 'none'),
          minWidth: 0,
          overflow: 'hidden',
        }}>
          <SpeedReader
            onNavigateToPdf={() => setCurrentView('pdf')}
            isActive={isSplitView || currentView === 'reader'}
            isSplitView={isSplitView}
            onToggleSplitView={toggleSplitView}
          />
        </div>
      </div>
    </ReadingProvider>
  );
}

export default App;
