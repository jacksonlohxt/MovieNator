# Offline Producer Intake evaluation

Run the synthetic evaluation with:

```sh
npm run eval
```

The command reads only the fixtures under `eval/fixtures/` and runs the local deterministic Producer Intake builder. It writes one JSON report and one Markdown summary per fixture, plus `aggregate.json` and `summary.md`, to `eval/results/` by default. The generated files are ignored by `eval/results/.gitignore`.

Useful options:

```sh
npm run eval -- --fixture northline-conflict --no-write
npm run eval -- --output /tmp/movieinator-eval
```

Each manifest carries known ground truth for seeded conflicts, seeded unknowns or gaps, and facts with exact source locations. The harness scores conflict recall, unknown/gap recall, citation accuracy, and false-positive/invention rate. The latter audits atomic cited evidence rows only; synthesized executive prose and absence-only questions are excluded.

NotebookLM and incumbent workflow records are structural comparison scaffolds with explicit `not_run` status. This harness makes no network, provider, account, credential, NotebookLM, or incumbent call. Synthetic scores are not customer validation, handoff acceptance, or market evidence.
