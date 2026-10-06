// Statut d'une stratégie en test, partagé par les onglets Stratégies, Radar,
// la fiche d'un marché et le portefeuille. Toujours un libellé (jamais la
// couleur seule).

export const MIN_BETS = 50; // en dessous, pas de conclusion

export function strategyStatus(x) {
  const n = x?.nExec ?? x?.n ?? 0;
  if (!n) return { key: "wait", rank: 2, icon: "⏳", label: "Pas encore de résultat" };
  if (n < MIN_BETS) return { key: "test", rank: 1, icon: "🔬", label: `En test (${n}/${MIN_BETS} paris)` };
  if (x.ci && x.ci[0] > 0) return { key: "good", rank: 0, icon: "✅", label: "Prometteuse" };
  if (x.ci && x.ci[1] < 0) return { key: "bad", rank: 4, icon: "❌", label: "Rejetée" };
  return { key: "test", rank: 1, icon: "➖", label: "Pas de conclusion" };
}

// Résumé de chaque test en direct, d'après les fichiers chargés
export function strategySummaries(state) {
  const fav = state.strategy?.variants ?? (state.strategy?.summary ? { "24h": state.strategy.summary } : {});
  return {
    fav24: { name: "Favoris sport, 24 h avant", s: fav["24h"] },
    favValue: { name: "Favoris sport, à bon prix", s: fav["24h"]?.value },
    fav4: { name: "Favoris sport, 2-6 h avant", s: fav["4h"] },
    copy: { name: "Copier les paris suspects", s: state.copy?.summary },
    odds: { name: "Moins cher que les bookmakers", s: state.odds?.summary },
    cross: { name: "Moins cher que Kalshi", s: state.cross?.summary },
    fresh: { name: "Marchés neufs, au vrai prix", s: state.fresh?.summary },
    // Idées déjà rejetées par le backtest
    crypto: { name: "Modèle crypto", s: null, rejected: true },
  };
}

export function statusBadge(st) {
  return `<span class="dash-status ${st.key}"><span aria-hidden="true">${st.icon}</span> ${st.label}</span>`;
}
