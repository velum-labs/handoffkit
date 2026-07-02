# Fusion Hill-Climb Report

- Role: synthesizer_system
- Advisory budget: $100.00

## Diagnosis (frozen bank)

- Best single model: opus (0.5133)
- Oracle ceiling: 0.6533; headroom over best single: 0.1400
- Mean failure correlation (lower = more decorrelated): 0.6132
- Lopsided (low headroom): no -- headroom exists: candidates fail on different tasks, so a better judge/synthesizer can convert oracle headroom into real fused wins

## Result

- Val: fused 1.0000 vs best single 0.7692 (uplift 0.2308, beats=no)
- LOCKED test (16 tasks): fused 0.9375 vs best single 0.6875 (uplift 0.2500)
- Test McNemar: wins=5 losses=1 significant=no
- COMPOUND BEATS BEST SINGLE (locked test): no

## Regret split (locked test)

- Oracle 1.0000 -> judge pick 0.9375 -> fused 0.9375
- Total regret: 0.0625 = judge 0.0625 + synthesis 0.0000
- Judge picks named: 13/16; decision-task pick accuracy: 0.9231 (strict exactly-one-correct: 1.0000)
