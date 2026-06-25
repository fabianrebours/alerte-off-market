import { useEffect, useState, type FormEvent } from 'react';
import { api, definirToken, ErreurAuth, type StatutIntegrations } from './api.ts';
import { ListeBiens } from './components/ListeBiens.tsx';
import { DetailBien } from './components/DetailBien.tsx';
import { Journal } from './components/Journal.tsx';
import { Connexions } from './components/Connexions.tsx';

type Vue = 'liste' | 'journal' | 'connexions';

export function App() {
  const [statut, setStatut] = useState<StatutIntegrations | null>(null);
  const [besoinAuth, setBesoinAuth] = useState(false);
  const [vue, setVue] = useState<Vue>('liste');
  const [refSelectionne, setRefSelectionne] = useState<string | null>(null);

  useEffect(() => {
    api.statut().then(setStatut).catch((e) => {
      if (e instanceof ErreurAuth) setBesoinAuth(true);
      else setStatut(null);
    });
  }, []);

  if (besoinAuth) return <PortailToken />;

  return (
    <div className="min-h-screen">
      <header className="bg-matera-900 text-white sticky top-0 z-10 shadow">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-6">
          <button
            onClick={() => { setRefSelectionne(null); setVue('liste'); }}
            className="font-bold tracking-wide text-sm hover:opacity-90"
          >
            MATERA · ALERTE OFF-MARKET
          </button>
          <nav className="flex gap-1 text-sm">
            <button
              onClick={() => { setRefSelectionne(null); setVue('liste'); }}
              className={`px-3 py-1.5 rounded ${vue === 'liste' && !refSelectionne ? 'bg-white/15' : 'hover:bg-white/10'}`}
            >Biens</button>
            <button
              onClick={() => { setRefSelectionne(null); setVue('journal'); }}
              className={`px-3 py-1.5 rounded ${vue === 'journal' && !refSelectionne ? 'bg-white/15' : 'hover:bg-white/10'}`}
            >Journal</button>
            <button
              onClick={() => { setRefSelectionne(null); setVue('connexions'); }}
              className={`px-3 py-1.5 rounded ${vue === 'connexions' && !refSelectionne ? 'bg-white/15' : 'hover:bg-white/10'}`}
            >Connexions</button>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs">
            {statut && (
              <>
                <Pastille ok={statut.modelo} label="Modelo" />
                <Pastille ok={statut.omni} label="Omni" />
                <Pastille ok={statut.gmailDelegation || statut.gmailAgent} label="Gmail" />
                {statut.sandbox && (
                  <span className="bg-amber-400 text-amber-950 font-semibold px-2 py-1 rounded">
                    BAC À SABLE
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {refSelectionne ? (
          <DetailBien
            refBien={refSelectionne}
            sandbox={statut?.sandbox ?? true}
            onRetour={() => setRefSelectionne(null)}
          />
        ) : vue === 'liste' ? (
          <ListeBiens onOuvrir={setRefSelectionne} />
        ) : vue === 'journal' ? (
          <Journal />
        ) : (
          <Connexions />
        )}
      </main>
    </div>
  );
}

function Pastille({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-bordeaux-600' : 'bg-stone-300'}`} />
      {label}
    </span>
  );
}

/** Portail d'accès : saisie du jeton API (stocké en localStorage) quand l'API renvoie 401. */
function PortailToken() {
  const [valeur, setValeur] = useState('');
  const valider = (e: FormEvent) => {
    e.preventDefault();
    if (!valeur.trim()) return;
    definirToken(valeur);
    window.location.reload();
  };
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <form onSubmit={valider} className="bg-white rounded-2xl shadow-sm p-8 max-w-sm w-full">
        <div className="text-bordeaux-800 font-bold tracking-wide text-sm mb-1">MATERA · ALERTE OFF-MARKET</div>
        <h1 className="text-lg font-bold text-slate-800 mb-2">Accès protégé</h1>
        <p className="text-sm text-slate-500 mb-4">Colle le jeton d'accès (fourni par l'admin) pour utiliser l'outil.</p>
        <input
          type="password" value={valeur} onChange={(e) => setValeur(e.target.value)} autoFocus
          placeholder="Jeton d'accès"
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-matera-500 focus:border-matera-500 outline-none"
        />
        <button type="submit" className="mt-4 w-full px-4 py-2.5 bg-matera-700 text-white rounded-lg text-sm font-semibold hover:bg-matera-900">
          Entrer
        </button>
      </form>
    </div>
  );
}
