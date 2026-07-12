
// App entry point for Sales Tax Calculator
import React, { useState, useEffect, useRef } from 'react';
import { AddressData, Suggestion, TaxResponse } from './types.ts';
import { getAddressSuggestions, lookupTaxRates } from './services/geminiService.ts';
import TaxResults from './components/TaxResults.tsx';
import { FUNNY_QUOTES } from './constants.ts';

const App: React.FC = () => {
  const [address, setAddress] = useState<AddressData>({ street: '', city: '', zip: '', state: '' });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [loadingTax, setLoadingTax] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("Checking...");
  const [taxData, setTaxData] = useState<TaxResponse | null>(null);
  const [history, setHistory] = useState<TaxResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isOhioOnly, setIsOhioOnly] = useState(true);
  const [quote, setQuote] = useState("");
  
  const suggestionRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<any>(null);

  useEffect(() => {
    // Get quote based on day and hour for hourly rotation
    const now = new Date();
    const day = now.getDate();
    const hour = now.getHours();
    const year = now.getFullYear();
    const month = now.getMonth();
    
    // Simple seed-based random selection
    // This ensures the quote stays the same for the entire hour
    // Using a more unique seed for better randomness
    const seed = (year * 10000) + ((month + 1) * 1000) + (day * 100) + hour;
    const pseudoRandomIndex = (seed * 9301 + 49297) % 233280;
    const quoteIndex = Math.floor((pseudoRandomIndex / 233280) * FUNNY_QUOTES.length);
    
    setQuote(FUNNY_QUOTES[quoteIndex]);

    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionRef.current && !suggestionRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleStreetChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setAddress(prev => ({ ...prev, street: value }));
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    if (value.length >= 2) {
      setLoadingSuggestions(true);
      debounceTimer.current = setTimeout(async () => {
        try {
          const results = await getAddressSuggestions(value, isOhioOnly ? "Ohio Only" : "USA");
          setSuggestions(results);
          setShowSuggestions(results.length > 0);
        } finally {
          setLoadingSuggestions(false);
        }
      }, 500);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const handleSelectSuggestion = (s: Suggestion) => {
    setAddress({
      street: s.street,
      city: s.city,
      state: s.state,
      zip: s.zip
    });
    setSuggestions([]);
    setShowSuggestions(false);
    setError(null);
  };

  const handleLookup = async () => {
    if (!address.street || !address.city || !address.zip) {
      setError("Please select an address or fill in all fields.");
      return;
    }
    setError(null);
    setLoadingTax(true);
    setTaxData(null);
    setLoadingStatus(isOhioOnly ? "Accessing Ohio DB..." : "Querying Registries...");
    try {
      const data = await lookupTaxRates(address, isOhioOnly);
      setTaxData(data);
      setHistory(prev => {
        const filtered = prev.filter(h => h.locationName !== data.locationName);
        return [data, ...filtered].slice(0, 3);
      });
    } catch (err: any) {
      setError("Calculation failed. Please verify the address.");
    } finally {
      setLoadingTax(false);
    }
  };

  const handleClear = () => {
    setAddress({ street: '', city: '', zip: '', state: '' });
    setSuggestions([]);
    setShowSuggestions(false);
    setTaxData(null);
    setError(null);
  };

  const inputClass = "w-full bg-white text-gray-900 border-2 border-gray-100 rounded-2xl px-5 py-4 focus:outline-none focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 transition-all placeholder-gray-400 font-medium shadow-sm text-sm";

  return (
    <div className="min-h-screen bg-sky-600 flex flex-col items-center justify-center p-4">
      {/* Quote of the Day */}
      <div className="mb-6 text-center max-w-2xl animate-in fade-in slide-in-from-top-4 duration-700">
        <span className="text-[12px] font-black text-sky-200 uppercase tracking-[0.3em] block mb-1">Nonsensical Wisdom of the Day</span>
        <p className="text-white font-medium italic text-xl leading-tight tracking-tight drop-shadow-sm">
          "{quote}"
        </p>
      </div>

      <div className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl overflow-hidden flex flex-col md:flex-row min-h-[720px] relative">
        <div className="w-full md:w-[440px] p-8 md:p-14 border-r border-gray-50 flex flex-col bg-white">
          <div className="flex items-center space-x-5 mb-10">
            <div className="w-20 h-20 flex items-center justify-center cursor-pointer logo-animate bg-sky-50 rounded-2xl border border-sky-100/50">
              <img src="https://storage.googleapis.com/tax-rate-calculator-assets/logo.png" alt="Logo" className="w-full h-full object-contain p-1" referrerPolicy="no-referrer" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-gray-900 tracking-tighter uppercase leading-none">Sales Tax Calculator</h1>
            </div>
          </div>

          <div className="mb-10 p-5 bg-gray-50 rounded-3xl border border-gray-100 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className={`p-2 rounded-xl transition-colors ${isOhioOnly ? 'bg-sky-100' : 'bg-gray-200'}`}>
                <i className={`fa-solid fa-map-pin ${isOhioOnly ? 'text-sky-600' : 'text-gray-400'}`}></i>
              </div>
              <div>
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest block">Operational Mode</span>
                <span className={`text-xs font-bold transition-colors ${isOhioOnly ? 'text-sky-700' : 'text-gray-600'}`}>
                  {isOhioOnly ? 'Ohio Strict Mode' : 'Nationwide Mode'}
                </span>
              </div>
            </div>
            <button 
              onClick={() => setIsOhioOnly(!isOhioOnly)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${isOhioOnly ? 'bg-sky-600' : 'bg-gray-300'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isOhioOnly ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="space-y-7 flex-grow">
            <div className="relative" ref={suggestionRef}>
              <div className="flex justify-between items-center mb-2.5">
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">Street Address</label>
                {address.street && <button onClick={handleClear} className="text-[10px] font-bold text-sky-600 hover:underline">RESET</button>}
              </div>
              <div className="relative group">
                <input 
                  type="text" 
                  placeholder={isOhioOnly ? "Start typing Ohio address..." : "Search any US address..."}
                  value={address.street} 
                  onChange={handleStreetChange} 
                  className={inputClass} 
                  autoComplete="off" 
                />
                <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center space-x-3 pointer-events-none">
                  {loadingSuggestions && <div className="animate-spin rounded-full h-4 w-4 border-2 border-sky-500 border-t-transparent"></div>}
                  <i className={`fa-solid fa-magnifying-glass transition-colors ${loadingSuggestions ? 'opacity-0' : 'text-gray-200 group-focus-within:text-sky-500'}`}></i>
                </div>
              </div>
              
              {showSuggestions && (
                <div className="absolute z-[100] left-0 right-0 mt-2 bg-white rounded-[2rem] shadow-2xl border border-gray-100 overflow-hidden max-h-[320px] overflow-y-auto animate-in fade-in slide-in-from-top-2">
                  <div className="px-6 py-3 bg-gray-50/50 border-b border-gray-100 text-[9px] font-black text-gray-400 uppercase tracking-widest">
                    {isOhioOnly ? 'Ohio Matches Found' : 'Nearby Results'}
                  </div>
                  {suggestions.map((s, idx) => (
                    <button 
                      key={idx} 
                      onClick={() => handleSelectSuggestion(s)} 
                      className="w-full text-left px-7 py-5 hover:bg-sky-50 transition-colors border-b border-gray-50 last:border-none group"
                    >
                      <p className="font-bold text-gray-800 text-[14px] group-hover:text-sky-700">{s.street}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">{s.city}, {s.state} {s.zip}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-5">
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 block px-1">City</label>
                <input type="text" placeholder="City" value={address.city} onChange={(e) => setAddress(p => ({ ...p, city: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2 block px-1">ZIP</label>
                <input type="text" placeholder="ZIP" value={address.zip} onChange={(e) => setAddress(p => ({ ...p, zip: e.target.value }))} className={inputClass} />
              </div>
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-100 rounded-2xl p-4 flex items-center space-x-3 animate-in fade-in slide-in-from-bottom-2">
                <i className="fa-solid fa-triangle-exclamation text-rose-500 text-xs"></i>
                <p className="text-xs font-bold text-rose-700">{error}</p>
              </div>
            )}
          </div>

          <button onClick={handleLookup} disabled={loadingTax} className="w-full bg-sky-600 hover:bg-sky-700 active:scale-[0.98] disabled:bg-gray-100 disabled:text-gray-400 text-white font-black py-7 rounded-[2rem] transition-all shadow-xl shadow-sky-600/20 flex items-center justify-center space-x-4 mt-12 overflow-hidden">
            {loadingTax ? (
              <span className="flex items-center space-x-3">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></div>
                <span className="tracking-widest uppercase text-xs">{loadingStatus}</span>
              </span>
            ) : (
              <>
                <i className="fa-solid fa-calculator text-xl"></i>
                <span className="tracking-widest uppercase text-sm">Find Tax Rates</span>
              </>
            )}
          </button>
        </div>

        <div className="flex-grow bg-[#FBFBFC] p-8 md:p-16 overflow-y-auto">
          <TaxResults data={taxData} loading={loadingTax} history={history} />
        </div>
      </div>
    </div>
  );
};

export default App;
