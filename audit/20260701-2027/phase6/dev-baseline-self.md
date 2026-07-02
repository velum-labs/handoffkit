# Fusion Hill-Climb Report

- Role: synthesizer_system
- Advisory budget: $100.00

## Diagnosis (frozen bank)

- Best single model: gpt (0.5267)
- Oracle ceiling: 0.5933; headroom over best single: 0.0667
- Mean failure correlation (lower = more decorrelated): -
- Lopsided (low headroom): no -- headroom exists: candidates fail on different tasks, so a better judge/synthesizer can convert oracle headroom into real fused wins

## Result

- Val: fused 1.0000 vs best single 0.5714 (uplift 0.4286, beats=no)
- LOCKED test (9 tasks): fused 0.8889 vs best single 0.5556 (uplift 0.3333)
- Test McNemar: wins=3 losses=0 significant=no
- COMPOUND BEATS BEST SINGLE (locked test): no

## Regret split (locked test)

- Oracle 1.0000 -> judge pick 0.8889 -> fused 0.8889
- Total regret: 0.1111 = judge 0.1111 + synthesis 0.0000
- Judge picks named: 8/9; decision-task pick accuracy: 0.8750 (strict exactly-one-correct: 1.0000)
