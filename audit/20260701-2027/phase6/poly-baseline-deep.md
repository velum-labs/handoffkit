# Fusion Hill-Climb Report

- Role: synthesizer_system
- Advisory budget: $100.00

## Diagnosis (frozen bank)

- Best single model: opus (0.7670)
- Oracle ceiling: 0.8544; headroom over best single: 0.0874
- Mean failure correlation (lower = more decorrelated): 0.3703
- Lopsided (low headroom): no -- headroom exists: candidates fail on different tasks, so a better judge/synthesizer can convert oracle headroom into real fused wins

## Result

- Val: fused 0.9231 vs best single 0.9231 (uplift 0.0000, beats=no)
- LOCKED test (17 tasks): fused 0.6471 vs best single 0.8235 (uplift -0.1765)
- Test McNemar: wins=2 losses=5 significant=no
- COMPOUND BEATS BEST SINGLE (locked test): no

## Regret split (locked test)

- Oracle 1.0000 -> judge pick 0.7059 -> fused 0.6471
- Total regret: 0.3529 = judge 0.2941 + synthesis 0.0588
- Judge picks named: 14/17; decision-task pick accuracy: 0.6429 (strict exactly-one-correct: -)
