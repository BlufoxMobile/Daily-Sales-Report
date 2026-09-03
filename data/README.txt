Drop your daily Blufox Sales Report here as: latest_report.xl

Generated files in this folder (do not edit by hand):
  tsheet-counts.json - per-store, per-rep t-sheet counts for today and the fiscal cycle.
  tsheet-flags.json  - rapid-fire results: the same rep filing 2+ t-sheets within 5
                       minutes at the same store. Paired to tsheet-counts.json by run_id.

Both are built every 10 min by the "Build t-sheet counts" workflow, which commits with
[skip ci]. Those commits do NOT trigger a Pages deploy, so these files only reach
blufoxmobile.github.io when another push or the Daily Sales Board Update schedule
publishes the site.sx
