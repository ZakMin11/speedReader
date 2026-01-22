import React, { useState, useEffect, useRef, useCallback } from 'react';
import './SpeedReader.css';

const SpeedReader = () => {
  // Hardcoded text for development
  const text = "I t was a bright cold day in April, and the clocks were strik- ing thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions, though not quickly enough to prevent a swirl of gritty dust from enter- ing along with him";
  
  const words = text.split(/\s+/).filter(word => word.length > 0);
  
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpm] = useState(250);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Calculate ORP index for a word
  const calculateORP = (word: string): number => {
    return Math.round(word.length * 0.35);
  };

  // Get word parts
  const getWordParts = () => {
    if (words.length === 0) return { before: '', orp: '', after: '' };
    
    const word = words[currentWordIndex];
    const orpIndex = calculateORP(word);
    
    return {
      before: word.substring(0, orpIndex),
      orp: word.charAt(orpIndex),
      after: word.substring(orpIndex + 1)
    };
  };

  const wordParts = getWordParts();

  // Play/Pause functionality
  const play = useCallback(() => {
    if (currentWordIndex >= words.length) {
      setCurrentWordIndex(0);
    }
    
    setIsPlaying(true);
    
    const interval = 60000 / wpm;
    
    intervalRef.current = setInterval(() => {
      setCurrentWordIndex(prev => {
        const next = prev + 1;
        if (next >= words.length) {
          setIsPlaying(false);
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          return words.length - 1;
        }
        return next;
      });
    }, interval);
  }, [currentWordIndex, wpm, words.length]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const togglePlayPause = () => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  // Navigation functions
  const goBack = () => {
    const wasPlaying = isPlaying;
    if (isPlaying) pause();
    
    setCurrentWordIndex(prev => Math.max(0, prev - 5));
    
    if (wasPlaying) {
      setTimeout(() => play(), 50);
    }
  };

  const goForward = () => {
    const wasPlaying = isPlaying;
    if (isPlaying) pause();
    
    setCurrentWordIndex(prev => Math.min(words.length - 1, prev + 5));
    
    if (wasPlaying) {
      setTimeout(() => play(), 50);
    }
  };

  const resetToStart = () => {
    const wasPlaying = isPlaying;
    if (isPlaying) pause();
    
    setCurrentWordIndex(0);
    
    if (wasPlaying) {
      setTimeout(() => play(), 50);
    }
  };

  // Speed control
  const updateSpeed = (newWpm: number) => {
    setWpm(newWpm);
    
    if (isPlaying) {
      pause();
      setTimeout(() => play(), 50);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        goForward();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, currentWordIndex, wpm]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // Calculate progress
  const progress = ((currentWordIndex + 1) / words.length) * 100;

  return (
    <div className="speed-reader-container">
      <div className="speed-reader-content">
        <h1>⚡ Speed Reader - ORP Mode</h1>
        
        <div className="reader-display">
          <div className="center-line"></div>
          <div className="word-container">
            <span className="word-before">{wordParts.before}</span>
            <span className="word-orp">{wordParts.orp}</span>
            <span className="word-after">{wordParts.after}</span>
          </div>
        </div>

        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }}></div>
        </div>

        <div className="info-text">
          Word {currentWordIndex + 1} of {words.length}
        </div>

        <div className="controls">
          <div className="control-row">
            <div className="speed-control">
              <label htmlFor="speedSlider">Speed:</label>
              <input
                type="range"
                id="speedSlider"
                min="60"
                max="1000"
                value={wpm}
                step="10"
                onChange={(e) => updateSpeed(parseInt(e.target.value))}
              />
              <span className="speed-value">{wpm} WPM</span>
            </div>
          </div>

          <div className="control-row button-group">
            <button
              className={isPlaying ? 'btn-secondary' : 'btn-primary'}
              onClick={togglePlayPause}
            >
              {isPlaying ? '⏸️ Pause' : '▶️ Play'}
            </button>
            <button className="btn-secondary" onClick={goBack}>
              ⏮️ Back 5
            </button>
            <button className="btn-secondary" onClick={goForward}>
              ⏭️ Forward 5
            </button>
            <button className="btn-reset" onClick={resetToStart}>
              ⏮️ Reset to Start
            </button>
          </div>
        </div>

        <div className="keyboard-shortcuts">
          <h3>⌨️ Keyboard Shortcuts</h3>
          <div className="shortcut">
            <span className="key">Space</span>
            <span>Play / Pause</span>
          </div>
          <div className="shortcut">
            <span className="key">← Left</span>
            <span>Go back 5 words</span>
          </div>
          <div className="shortcut">
            <span className="key">→ Right</span>
            <span>Go forward 5 words</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SpeedReader;