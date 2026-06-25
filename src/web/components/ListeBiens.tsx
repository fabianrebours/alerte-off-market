import { useEffect, useState } from 'react';
import { api, prixFr, dateFr, type BienDetecte, type StatutBien } from '../api.ts';

type Filtre = StatutBien | 'tous';

const FILTRES: { cle: Filtre; label: string }[] = [
  { cle: 'nouveau', label: 'À traiter' },
  { cle: 'envoye', label: 'Envoyés' },
  { cle: 'ignore', label: 'Backlog' },
  { cle: 'tous', label: 'Tous' },
];

const BADGE: Record<StatutBien, string> = {
  nouveau: 'bg-sable-100 text-sable-800',
  envoye: 'bg-bordeaux-50 text-bordeaux-700',
  ignore: 'bg-slate-200 text-slate-600',
};
const BADGE_LABEL: Record<StatutBien, string> = {
  nouveau: 'À traiter', envoye: 'Envoyé', ignore: 'Backlog',
};

/** Badge de progression d'envoi : X/total, ou ✓ traité quand la file est vide. */
function Progression({ envoyes, enAttente }: { envoyes: number; enAttente: number }) {
  const total = envoyes + enAttente;
  if (total === 0) return null;
  if (enAttente === 0) {
    return <span className="text-bordeaux-700 font-medium whitespace-nowrap">✓ {envoyes}/{total} traité</span>;
  }
  return <span className="text-amber-600 font-medium whitespace-nowrap">{envoyes}/{total} envoyés</span>;
}

export function ListeBiens({ onOuvrir }: { onOuvrir: (ref: string) => void }) {
  const [filtre, setFiltre] = useState<Filtre>('nouveau');
  const [biens, setBiens] = useState<BienDetecte[]>([]);
  const [chargement, setChargement] = useState(true);
  const [pollEnCours, setPollEnCours] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const charger = (f: Filtre) => {
    setChargement(true);
    api.biens(f === 'tous' ? undefined : f)
      .then(setBiens)
      .catch((e) => setMessage(e.message))
      .finally(() => setChargement(false));
  };

  useEffect(() => { charger(filtre); }, [filtre]);

  const rafraichir = async () => {
    setPollEnCours(true);
    setMessage(null);
    try {
      const r = await api.poll();
      setMessage(`${r.nouveaux} nouveau(x) bien(s) off-market · ${r.total} candidat(s) récents sur Modelo.`);
      charger(filtre);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setPollEnCours(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <div className="flex gap-1 bg-white rounded-lg p-1 shadow-sm">
          {FILTRES.map((f) => (
            <button
              key={f.cle}
              onClick={() => setFiltre(f.cle)}
              className={`px-3 py-1.5 rounded text-sm font-medium ${filtre === f.cle ? 'bg-matera-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >{f.label}</button>
          ))}
        </div>
        <button
          onClick={rafraichir}
          disabled={pollEnCours}
          className="ml-auto px-4 py-2 bg-matera-500 text-white rounded-lg text-sm font-medium hover:bg-matera-700 disabled:opacity-50"
        >{pollEnCours ? 'Analyse Modelo…' : '↻ Rafraîchir Modelo'}</button>
      </div>

      {message && <div className="mb-4 text-sm bg-bordeaux-50 text-bordeaux-800 px-4 py-2 rounded-lg">{message}</div>}

      {chargement ? (
        <p className="text-slate-500 text-sm">Chargement…</p>
      ) : biens.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <p className="text-sm">Aucun bien dans cette catégorie.</p>
          <p className="text-xs mt-1">Clique sur « Rafraîchir Modelo » pour détecter les biens sur le marché.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {biens.map((b) => (
            <button
              key={b.productRef}
              onClick={() => onOuvrir(b.productRef)}
              className="bg-white rounded-xl shadow-sm hover:shadow-md transition text-left overflow-hidden group"
            >
              <div className="aspect-[4/3] bg-slate-200 relative overflow-hidden">
                {b.bien.photos[0]
                  ? <img src={b.bien.photos[0]} alt="" className="w-full h-full object-cover group-hover:scale-105 transition" />
                  : <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">sans photo</div>}
                <span className={`absolute top-2 left-2 text-xs font-semibold px-2 py-0.5 rounded ${BADGE[b.statut]}`}>
                  {BADGE_LABEL[b.statut]}
                </span>
              </div>
              <div className="p-3">
                <div className="font-semibold text-slate-800 text-sm line-clamp-1">{b.bien.titre ?? b.bien.typeBien ?? 'Bien'}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {[b.bien.ville, b.bien.codePostal].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-matera-700 font-bold text-sm">{prixFr(b.bien.prix)}</span>
                  <span className="text-xs text-slate-500">
                    {[b.bien.surface ? `${b.bien.surface} m²` : null, b.bien.pieces ? `${b.bien.pieces} p.` : null].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
                  <span className="line-clamp-1">{b.bien.agentNom ?? '—'}</span>
                  <Progression envoyes={b.nbEnvoyes} enAttente={b.nbEnAttente} />
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {b.bien.dateCreation ? `Créé le ${dateFr(b.bien.dateCreation)}` : `Détecté ${dateFr(b.detectedAt)}`}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
