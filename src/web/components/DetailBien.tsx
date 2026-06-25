import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, prixFr, type DetailReponse, type DestinataireEnvoi, type ResultatEnvoi,
} from '../api.ts';

export function DetailBien({ refBien, sandbox, onRetour }: {
  refBien: string; sandbox: boolean; onRetour: () => void;
}) {
  const [data, setData] = useState<DetailReponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [sujet, setSujet] = useState('');
  const [message, setMessage] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [previewHtml, setPreviewHtml] = useState('');
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [resultat, setResultat] = useState<ResultatEnvoi | null>(null);

  const initialBrouillon = useRef({ sujet: '', message: '' });
  const charger = () => {
    setErreur(null);
    api.detail(refBien)
      .then((d) => {
        setData(d);
        setSujet(d.brouillon.sujet);
        setMessage(d.brouillon.message);
        initialBrouillon.current = { sujet: d.brouillon.sujet, message: d.brouillon.message };
        const eligibles = d.copros.flatMap((c) => c.coproprietaires.filter((p) => p.eligible).map((p) => p.email));
        setSelection(new Set(eligibles));
      })
      .catch((e) => setErreur(e.message));
  };
  useEffect(charger, [refBien]);

  // Aperçu live (debounce 400 ms).
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!data) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api.preview(refBien, message).then((r) => setPreviewHtml(r.html)).catch(() => {});
    }, 400);
    return () => clearTimeout(debounce.current);
  }, [message, data, refBien]);

  // Map email → infos copro (pour construire le payload d'envoi).
  const infoParEmail = useMemo(() => {
    const m = new Map<string, DestinataireEnvoi>();
    data?.copros.forEach((c) => c.coproprietaires.forEach((p) => {
      if (p.eligible) m.set(p.email, {
        email: p.email, prenom: p.prenom, nom: p.nom,
        commonholdId: c.commonholdId, coproAdresse: c.address, distanceKm: c.distanceKm,
      });
    }));
    return m;
  }, [data]);

  const toggle = (email: string) => {
    setSelection((s) => {
      const n = new Set(s);
      n.has(email) ? n.delete(email) : n.add(email);
      return n;
    });
  };
  const toggleCopro = (emails: string[], tousSelectionnes: boolean) => {
    setSelection((s) => {
      const n = new Set(s);
      emails.forEach((e) => tousSelectionnes ? n.delete(e) : n.add(e));
      return n;
    });
  };

  const envoyer = async () => {
    const etale = selection.size > 30 ? ` Les 30 premiers partent maintenant, le reste est programmé (30/jour les jours suivants).` : '';
    if (!confirm(sandbox
      ? `Mode bac à sable : ${selection.size} email(s) de test.${etale} Continuer ?`
      : `Envoyer à ${selection.size} copropriétaire(s) ?${etale}`)) return;
    setEnvoiEnCours(true);
    setResultat(null);
    try {
      const destinataires = [...selection].map((e) => infoParEmail.get(e)).filter(Boolean) as DestinataireEnvoi[];
      const r = await api.envoyer(refBien, sujet, message, destinataires);
      setResultat(r);
      charger(); // recharge : dejaContacte + statut à jour
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoiEnCours(false);
    }
  };

  const sauverBrouillon = () => {
    // Ne persiste que si l'agent a réellement modifié le brouillon par défaut
    // (sinon on figerait le défaut et masquerait les futures MAJ de données).
    if (sujet === initialBrouillon.current.sujet && message === initialBrouillon.current.message) return;
    api.brouillon(refBien, sujet, message).catch((e) => setErreur(e.message));
  };

  if (erreur && !data) return <ErreurBloc message={erreur} onRetour={onRetour} />;
  if (!data) return <p className="text-slate-500 text-sm">Chargement…</p>;

  const b = data.detecte.bien;
  const caracs: [string, string | null][] = [
    ['Type', b.typeBien], ['Surface', b.surface ? `${b.surface} m²` : null],
    ['Pièces', b.pieces?.toString() ?? null], ['Chambres', b.chambres?.toString() ?? null],
    ['Étage', b.etage?.toString() ?? null], ['Prix', prixFr(b.prix)],
    ['DPE', b.dpeLettre], ['Adresse', [b.adresse, b.codePostal, b.ville].filter(Boolean).join(', ') || null],
  ];

  return (
    <div>
      <button onClick={onRetour} className="text-sm text-matera-700 hover:underline mb-4">← Retour aux biens</button>

      {(() => {
        const env = data.detecte.nbEnvoyes, att = data.detecte.nbEnAttente, tot = env + att;
        if (tot === 0) return null;
        return (
          <div className={`mb-4 rounded-xl px-4 py-3 text-sm ${att === 0 ? 'bg-bordeaux-50 text-bordeaux-800' : 'bg-amber-50 text-amber-800'}`}>
            {att === 0
              ? <>✓ Campagne terminée — <strong>{env}/{tot}</strong> copropriétaire·s contacté·s.</>
              : <>Campagne en cours — <strong>{env}/{tot}</strong> envoyés, <strong>{att}</strong> encore programmés (30/jour).</>}
          </div>
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Colonne gauche : le bien ── */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            {b.photos[0] && <img src={b.photos[0]} alt="" className="w-full aspect-[4/3] object-cover" />}
            {b.photos.length > 1 && (
              <div className="flex gap-1 p-2 overflow-x-auto">
                {b.photos.slice(1, 7).map((p, i) => (
                  <img key={i} src={p} alt="" className="h-16 w-20 object-cover rounded shrink-0" />
                ))}
              </div>
            )}
            <div className="p-4">
              <h2 className="font-bold text-slate-800">{b.titre ?? b.typeBien ?? 'Bien'}</h2>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="text-xs bg-amber-100 text-amber-800 font-semibold px-2 py-0.5 rounded">
                  Sur le marché · off-market
                </span>
                {b.mandatType && (
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded ${b.mandatType === 'exclusif' ? 'bg-bordeaux-100 text-bordeaux-800' : b.mandatType === 'semi_exclusif' ? 'bg-sable-100 text-sable-800' : b.mandatType === 'delegation' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-200 text-slate-700'}`}>
                    {b.mandatType === 'delegation'
                      ? 'Délégation'
                      : `Mandat ${b.mandatType === 'semi_exclusif' ? 'semi-exclusif' : b.mandatType}`}
                  </span>
                )}
              </div>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {caracs.filter(([, v]) => v).map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-1 pr-3 text-slate-500 whitespace-nowrap align-top">{k}</td>
                      <td className="py-1 text-slate-800 font-medium">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500">
                Agent (signature) : <span className="font-medium text-slate-700">{b.agentNom ?? '—'}</span>
                {b.agentTelephone && <> · {b.agentTelephone}</>}
              </div>
              {b.description && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Description (Modelo)</div>
                  <p className="text-xs text-slate-600 whitespace-pre-line max-h-44 overflow-y-auto pr-1">{b.description}</p>
                </div>
              )}
              <a href={data.lienAnnonce} target="_blank" rel="noreferrer"
                className="mt-3 inline-block text-sm text-matera-700 hover:underline">
                Voir l'annonce (landing page) →
              </a>
            </div>
          </div>

          {/* Destinataires */}
          <Destinataires data={data} selection={selection} toggle={toggle} toggleCopro={toggleCopro} />
        </div>

        {/* ── Colonne droite : composition + aperçu ── */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Objet</label>
              <input
                value={sujet} onChange={(e) => setSujet(e.target.value)} onBlur={sauverBrouillon}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-matera-500 focus:border-matera-500 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mot de l'agent</label>
              <textarea
                value={message} onChange={(e) => setMessage(e.target.value)} onBlur={sauverBrouillon} rows={8}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-matera-500 focus:border-matera-500 outline-none resize-y font-[inherit]"
              />
              <p className="text-xs text-slate-400 mt-1">
                <code>{'{{distance}}'}</code> = distance de la copropriété au bien (personnalisé par destinataire) ·
                <code>{'{{lien}}'}</code> = lien cliquable vers l'annonce. La photo est ajoutée sous votre message.
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-2 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wide">Aperçu de l'email</div>
            <iframe title="aperçu" srcDoc={previewHtml} className="w-full h-[460px] bg-slate-50" />
          </div>
        </div>
      </div>

      {/* ── Barre d'envoi ── */}
      <div className="sticky bottom-0 mt-6 bg-white border-t border-slate-200 shadow-lg rounded-t-xl p-4 flex items-center gap-4">
        <div className="text-sm">
          <div>
            <span className="font-bold text-matera-900 text-lg">{selection.size}</span>
            <span className="text-slate-500"> destinataire·s sélectionné·s</span>
            <span className="text-slate-400"> · {data.nbEligibles} éligibles au total</span>
          </div>
          {data.expedition.canal !== 'aucun' ? (
            <div className="text-xs text-bordeaux-700 mt-0.5">✉ Envoi depuis <strong>{data.expedition.expediteur}</strong> · nom + tél. de l'agent en signature</div>
          ) : (
            <div className="text-xs text-red-500 mt-0.5">Aucun canal d'envoi configuré (ni délégation, ni compte connecté, ni Resend)</div>
          )}
        </div>
        {sandbox && (
          <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded font-medium">
            Bac à sable : tout part vers l'adresse de test
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => api.setStatut(refBien, data.detecte.statut === 'ignore' ? 'nouveau' : 'ignore').then(onRetour)}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          >{data.detecte.statut === 'ignore' ? 'Réactiver' : 'Ignorer ce bien'}</button>
          <button
            onClick={envoyer}
            disabled={envoiEnCours || selection.size === 0}
            className="px-6 py-2 bg-matera-700 text-white rounded-lg text-sm font-semibold hover:bg-matera-900 disabled:opacity-40"
          >{envoiEnCours ? 'Envoi…' : sandbox ? 'Envoyer (test)' : 'Envoyer'}</button>
        </div>
      </div>

      {resultat && (
        <div className="mt-4 bg-white rounded-xl shadow-sm p-4 text-sm">
          <div className="font-semibold text-slate-800 mb-1">
            {resultat.sandbox ? 'Test terminé' : 'Envoi terminé'}
            <span className="font-normal text-slate-500"> · {resultat.canal === 'gmail' ? `depuis ${resultat.expediteur}` : 'via Resend'}</span>
          </div>
          <div className="text-slate-600">
            {resultat.sandbox ? `${resultat.tests} envoyé·s maintenant (test)` : `${resultat.envoyes} envoyé·s maintenant`}
            {resultat.erreurs > 0 && <span className="text-red-600"> · {resultat.erreurs} erreur·s</span>}
            {resultat.ignores > 0 && <span className="text-slate-400"> · {resultat.ignores} exclu·s (désinscrit / déjà contacté / &lt;7j)</span>}
          </div>
          {resultat.programmes > 0 && (
            <div className="mt-2 text-xs text-slate-500">
              <span className="font-medium text-matera-700">{resultat.programmes} programmé·s</span> (max {/* taille lot */}30/jour) :
              <ul className="list-disc pl-4 mt-1">
                {resultat.planning.map((p) => (
                  <li key={p.jour}>{p.count} le {new Date(p.jour).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {erreur && <div className="mt-4 text-sm text-red-600">{erreur}</div>}
    </div>
  );
}

function Destinataires({ data, selection, toggle, toggleCopro }: {
  data: DetailReponse;
  selection: Set<string>;
  toggle: (email: string) => void;
  toggleCopro: (emails: string[], tous: boolean) => void;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <h3 className="font-semibold text-slate-800 text-sm mb-1">
        {data.copros.length} copropriété·s Matera ciblées
        {data.copros.some((c) => c.estCoproDuBien) && <span className="font-normal text-slate-400"> · dont celle du bien</span>}
      </h3>
      <p className="text-xs text-slate-400 mb-3">Les désinscrits, doublons et déjà-contactés sont exclus automatiquement.</p>
      {data.copros.length === 0 && <p className="text-sm text-slate-500">Aucune copropriété Matera trouvée à proximité.</p>}
      <div className="space-y-3">
        {data.copros.map((c) => {
          const eligibles = c.coproprietaires.filter((p) => p.eligible).map((p) => p.email);
          const tousSel = eligibles.length > 0 && eligibles.every((e) => selection.has(e));
          return (
            <div key={c.commonholdId} className="border border-slate-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <input type="checkbox" checked={tousSel} onChange={() => toggleCopro(eligibles, tousSel)}
                  disabled={eligibles.length === 0} className="mt-1 accent-matera-700" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-2">
                    {c.estCoproDuBien ? (
                      <span className="text-xs font-semibold bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded shrink-0">Copro du bien</span>
                    ) : c.distanceKm != null && (
                      <span className="text-xs font-semibold bg-matera-100 text-matera-700 px-1.5 py-0.5 rounded shrink-0">
                        {c.distanceKm < 1 ? `${Math.round(c.distanceKm * 1000)} m` : `${c.distanceKm.toFixed(1)} km`}
                      </span>
                    )}
                    <span className="truncate">{c.address || 'Adresse inconnue'}</span>
                  </div>
                  <div className="text-xs text-slate-400">
                    {[[c.postalCode, c.city].filter(Boolean).join(' '), c.units ? `${c.units} lots` : null]
                      .filter(Boolean).join(' · ')}
                    {' · '}{eligibles.length}/{c.coproprietaires.length} éligibles
                  </div>
                </div>
              </div>
              <div className="mt-2 pl-6 flex flex-wrap gap-1.5">
                {c.coproprietaires.map((p) => {
                  const raison = p.desinscrit ? 'désinscrit' : p.dejaContacte ? 'déjà contacté' : p.recemmentContacte ? 'contacté <7j' : !p.eligible ? 'doublon' : null;
                  return (
                    <label key={p.email}
                      className={`text-xs px-2 py-1 rounded border flex items-center gap-1.5 ${
                        p.eligible ? 'border-slate-200 bg-slate-50 cursor-pointer hover:bg-slate-100'
                        : 'border-slate-100 bg-slate-50 text-slate-300 line-through'}`}
                      title={raison ?? p.email}
                    >
                      {p.eligible && (
                        <input type="checkbox" checked={selection.has(p.email)} onChange={() => toggle(p.email)} className="accent-matera-700" />
                      )}
                      <span className="truncate max-w-[180px]">{p.email}</span>
                      {raison && <span className="text-[10px] text-slate-400 no-underline">({raison})</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ErreurBloc({ message, onRetour }: { message: string; onRetour: () => void }) {
  return (
    <div>
      <button onClick={onRetour} className="text-sm text-matera-700 hover:underline mb-4">← Retour</button>
      <div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm">{message}</div>
    </div>
  );
}
