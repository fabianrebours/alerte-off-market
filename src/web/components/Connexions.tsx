import { useEffect, useState } from 'react';
import { api, dateFr, type AgentConnecte } from '../api.ts';

export function Connexions() {
  const [agents, setAgents] = useState<AgentConnecte[]>([]);
  const [chargement, setChargement] = useState(true);
  const [delegation, setDelegation] = useState(false);

  useEffect(() => {
    api.agentsConnectes().then(setAgents).catch(() => {}).finally(() => setChargement(false));
    api.statut().then((s) => setDelegation(s.gmailDelegation)).catch(() => {});
  }, []);

  return (
    <div className="max-w-2xl">
      {delegation && (
        <div className="mb-4 bg-bordeaux-50 text-bordeaux-800 rounded-xl p-4 text-sm">
          ✓ <strong>Délégation domaine active</strong> — les mails partent de <strong>transactions@matera.eu</strong>
          sans aucune connexion à faire ici.
        </div>
      )}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="font-bold text-slate-800 text-lg">Compte d'envoi Google</h2>
        <p className="text-sm text-slate-500 mt-2 leading-relaxed">
          Connecte <strong>ton compte Google</strong> (ex. <code>fabian.rebours@matera.eu</code>),
          celui qui est autorisé à « Envoyer en tant que » <code>transactions@matera.eu</code>.
          Les mails s'authentifient via ce compte mais s'affichent avec l'adresse
          <code>transactions@matera.eu</code> ; le <strong>nom et le téléphone de l'agent</strong> sont en signature.
        </p>

        <a
          href="/oauth/google/start"
          className="inline-flex items-center gap-2 mt-4 px-4 py-2.5 bg-matera-700 text-white rounded-lg text-sm font-semibold hover:bg-matera-900"
        >
          Connecter le compte d'envoi
        </a>

        <div className="mt-6">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Compte(s) connecté(s) ({agents.length})
          </h3>
          {chargement ? (
            <p className="text-sm text-slate-400">Chargement…</p>
          ) : agents.length === 0 ? (
            <p className="text-sm text-slate-400">
              Aucun compte connecté. Tant que ni délégation ni compte connecté ni Resend ne sont
              configurés, l'envoi est indisponible.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
              {agents.map((a) => (
                <li key={a.email} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-slate-800">{a.email}</span>
                  <span className="text-xs text-slate-400">connecté le {dateFr(a.connectedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
