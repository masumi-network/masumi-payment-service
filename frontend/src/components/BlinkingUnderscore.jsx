import React from 'react';

const BlinkingUnderscore = () => {
  return (
    <div className="animate-blink" style={{ animation: 'blinking 1s infinite' }}>
      <style jsx>{`
        @keyframes blinking {
          0% {
            opacity: 0;
          }
          50% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }
      `}</style>
      _
    </div>
  );
};

export default BlinkingUnderscore;
