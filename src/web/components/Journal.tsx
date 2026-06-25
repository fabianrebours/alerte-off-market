import { useEffect, useState } from 'react';
import { api, dateFr, type Envoi } from '../api.ts';

const BADGE: Record<Envoi['statut'], string> = {
  envoye: 'bg-bordeaux-50 text-bordeaux-700',
  test: 'bg-amber-100 text-amber-800',
  erreur: 'bg-red-100 text-red-700',
};

export function Journal() {
  const [envois, setEnvois] = useState<Envoi[]>([]);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    api.envois().then(setEnvois).catch(() => {}).finally(() => setChargement(false));
  }, []);

  if (chargement) return <p className="text-slate-500 text-sm">Chargement…</p>;
  if (envois.length === 0) return <p className="text-slate-500 text-sm">Aucun envoi pour le moment.</p>;

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Date</th>
            <th className="text-left px-4 py-2 font-medium">Destinataire</th>
            <th className="text-left px-4 py-2 font-medium">Copropriété</th>
            <th className="text-left px-4 py-2 font-medium">Bien</th>
            <th className="text-left px-4 py-2 font-medium">Statut</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {envois.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50">
              <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{dateFr(e.sent_at)}</td>
              <td className="px-4 py-2">
                <div className="text-slate-800">{e.email}</div>
                {(e.prenom || e.nom) && <div className="text-xs text-slate-400">{[e.prenom, e.nom].filter(Boolean).join(' ')}</div>}
              </td>
              <td className="px-4 py-2 text-slate-600 text-xs max-w-[220px] truncate">{e.copro_adresse ?? '—'}</td>
              <td className="px-4 py-2 text-slate-500 text-xs">{e.product_ref}</td>
              <td className="px-4 py-2">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${BADGE[e.statut]}`}>
                  {e.statut === 'test' ? 'test' : e.statut}
                </span>
                {e.erreur && <div className="text-xs text-red-500 mt-0.5 max-w-[200px] truncate" title={e.erreur}>{e.erreur}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
