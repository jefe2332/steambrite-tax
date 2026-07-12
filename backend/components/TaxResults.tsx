
import React from 'react';
import { TaxResponse } from '../types';

interface TaxResultsProps {
  data: TaxResponse | null;
  loading: boolean;
  history: TaxResponse[];
}

const TaxResults: React.FC<TaxResultsProps> = ({ data, loading, history }) => {
  const logoUrl = "https://storage.googleapis.com/tax-rate-calculator-assets/logo.png";
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full space-y-6 py-12">
        <div className="relative">
          <div className="animate-spin rounded-full h-24 w-24 border-4 border-sky-100 border-t-sky-600"></div>
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-full p-4">
            <img src={logoUrl} alt="Loading..." className="w-full h-full object-contain animate-pulse" referrerPolicy="no-referrer" />
          </div>
        </div>
        <div className="text-center">
          <p className="text-gray-900 font-bold text-xl mb-1">Checking Registry</p>
          <p className="text-gray-500 text-sm">Validating local tax codes...</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 text-center">
        <div className="mb-20 w-48 h-48 flex items-center justify-center cursor-pointer relative group pop-out-3d">
          {/* Static Logo */}
          <img 
            src={logoUrl} 
            alt="Calculator Logo" 
            className="w-full h-full object-contain opacity-90 group-hover:opacity-0 transition-opacity duration-300" 
            referrerPolicy="no-referrer"
          />
          {/* Secret Booty Shake Video */}
          <video
            className="absolute inset-0 w-full h-full object-contain opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-3xl mix-blend-screen"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            poster={logoUrl}
          >
            <source src="https://storage.googleapis.com/tax-rate-calculator-assets/booty-shake-v2.mp4" type="video/mp4" />
          </video>
          {/* Fun Label */}
          <div className="absolute -bottom-12 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-500 whitespace-nowrap z-10">
            <span className="text-[10px] font-black text-sky-500 uppercase tracking-[0.2em] bg-sky-50 px-3 py-1 rounded-full border border-sky-100 shadow-sm">
              Shake it for the rates!
            </span>
          </div>
        </div>
        <div className="mt-2">
          <h3 className="text-2xl font-bold text-gray-900 mb-2">Ready to Calculate</h3>
          <p className="text-gray-500 text-base max-w-[300px] leading-relaxed font-medium">
            Start typing your address for instant Ohio rates or AI-grounded nationwide data.
          </p>
        </div>
      </div>
    );
  }

  const formatPercent = (val: number) => (val * 100).toFixed(2) + '%';

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h3 className="text-2xl font-bold text-gray-900">Tax Breakdown</h3>
          <p className="text-xs text-gray-500 font-medium mt-1 uppercase tracking-widest">{data.locationName}</p>
        </div>
        <div className={`text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full shadow-lg flex items-center space-x-2 ${
          data.isLocalMatch ? 'bg-amber-100 text-amber-700 shadow-amber-600/10' : 'bg-sky-600 text-white shadow-sky-600/20'
        }`}>
          {data.isLocalMatch && <i className="fa-solid fa-bolt-lightning text-[8px]"></i>}
          <span>{data.isLocalMatch ? 'Instant Database Match' : 'AI Verified'}</span>
        </div>
      </div>
      
      <div className="bg-white rounded-[2rem] p-8 shadow-xl shadow-gray-200/50 border border-gray-100 space-y-6 mb-8">
        <div className="flex justify-between items-center pb-5 border-b border-gray-50">
          <div>
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">State</span>
            <span className="text-base font-bold text-gray-800">{data.state.name}</span>
          </div>
          <span className="text-2xl font-black text-gray-900">{formatPercent(data.state.rate)}</span>
        </div>

        <div className="flex justify-between items-center pb-5 border-b border-gray-50">
          <div>
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">County</span>
            <span className="text-base font-bold text-gray-800">{data.county.name || 'Local Area'}</span>
          </div>
          <span className="text-2xl font-black text-gray-900">{formatPercent(data.county.rate)}</span>
        </div>

        {data.city && (data.city.rate > 0) && (
          <div className="flex justify-between items-center pb-5 border-b border-gray-50">
            <div>
              <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">City / Municipal</span>
              <span className="text-base font-bold text-gray-800">{data.city.name}</span>
            </div>
            <span className="text-2xl font-black text-gray-900">{formatPercent(data.city.rate)}</span>
          </div>
        )}

        {data.districts && data.districts.length > 0 && data.districts.map((d, idx) => (
          <div key={idx} className="flex justify-between items-center pb-5 border-b border-gray-50">
            <div>
              <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">Special Dist.</span>
              <span className="text-base font-bold text-gray-800">{d.name}</span>
            </div>
            <span className="text-2xl font-black text-gray-900">{formatPercent(d.rate)}</span>
          </div>
        ))}

        <div className="flex justify-between items-center pt-4">
          <span className="text-xl font-black text-gray-900 uppercase tracking-tighter">Combined Rate</span>
          <div className="text-right">
            <span className="text-6xl font-black text-sky-600 block leading-none tabular-nums tracking-tighter">{formatPercent(data.totalRate)}</span>
          </div>
        </div>
      </div>

      <div className="mb-12">
        <div className="flex items-center justify-between mb-4 px-1">
          <h4 className="text-[10px] text-gray-400 uppercase font-black tracking-widest">Verification Sources</h4>
          <i className="fa-solid fa-shield-halved text-sky-100 text-xs"></i>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {data.sources.slice(0, 2).map((source, i) => (
            <a 
              key={i} 
              href={source.uri} 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center p-4 bg-white border border-gray-100 rounded-2xl hover:border-sky-500 hover:shadow-lg transition-all group overflow-hidden"
            >
              <div className="bg-gray-50 p-2.5 rounded-xl mr-4 group-hover:bg-sky-50">
                <i className="fa-solid fa-link text-gray-300 group-hover:text-sky-500 text-xs"></i>
              </div>
              <span className="text-[11px] font-bold text-gray-700 truncate group-hover:text-sky-900">
                {source.title.split('|')[0].trim()}
              </span>
            </a>
          ))}
        </div>
      </div>

      {history.length > 1 && (
        <div className="mt-auto pt-8 border-t border-gray-100">
          <h4 className="text-[10px] text-gray-400 uppercase font-black tracking-widest mb-4 px-1">Recent Lookups</h4>
          <div className="space-y-3">
            {history.slice(1).map((item, idx) => (
              <div 
                key={idx} 
                className="flex items-center justify-between p-4 bg-white/50 rounded-2xl border border-gray-50 opacity-60 hover:opacity-100 transition-opacity"
              >
                <div className="flex flex-col">
                  <span className="text-[11px] font-bold text-gray-800 truncate max-w-[200px]">{item.locationName}</span>
                  <span className="text-[9px] text-gray-400 uppercase font-black tracking-tighter">{item.isLocalMatch ? 'Database Match' : 'AI Verified'}</span>
                </div>
                <span className="text-lg font-black text-gray-900">{formatPercent(item.totalRate)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaxResults;
