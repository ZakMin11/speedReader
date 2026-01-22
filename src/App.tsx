import { useState } from 'react';
import PdfViewer from './PdfViewer';
import SpeedReader from './SpeedReader';
import './App.css';

type Tab = 'pdf' | 'speed-reader';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('pdf');

  return (
    <div className="app-container">
      <div className="tab-navigation">
        <button
          className={`tab-button ${activeTab === 'pdf' ? 'active' : ''}`}
          onClick={() => setActiveTab('pdf')}
        >
          📄 PDF Viewer
        </button>
        <button
          className={`tab-button ${activeTab === 'speed-reader' ? 'active' : ''}`}
          onClick={() => setActiveTab('speed-reader')}
        >
          ⚡ Speed Reader
        </button>
      </div>

      <div className="tab-content">
        {activeTab === 'pdf' && <PdfViewer />}
        {activeTab === 'speed-reader' && <SpeedReader />}
      </div>
    </div>
  );
}

export default App;