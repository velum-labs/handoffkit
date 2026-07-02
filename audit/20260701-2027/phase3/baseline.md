# Fusion Hill-Climb Report

- Role: synthesizer_system
- Advisory budget: $100.00

## Diagnosis (frozen bank)

- Best single model: gpt (0.4767)
- Oracle ceiling: 0.5465; headroom over best single: 0.0698
- Mean failure correlation (lower = more decorrelated): 0.6509
- Lopsided (low headroom): no -- headroom exists: candidates fail on different tasks, so a better judge/synthesizer can convert oracle headroom into real fused wins

## Result

- Val: fused 1.0000 vs best single 0.7500 (uplift 0.2500, beats=no)
- LOCKED test (5 tasks): fused 1.0000 vs best single 0.6000 (uplift 0.4000)
- Test McNemar: wins=2 losses=0 significant=no
- COMPOUND BEATS BEST SINGLE (locked test): no

## Regret split (locked test)

- Oracle 1.0000 -> judge pick 1.0000 -> fused 1.0000
- Total regret: 0.0000 = judge 0.0000 + synthesis 0.0000
- Judge picks named: 3/5; decision-task pick accuracy: 1.0000 (strict exactly-one-correct: 1.0000)
