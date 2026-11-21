# Buy-Side Curriculum

Single-file, mobile-first finance course: `index.html`. Lessons mix short concept cards with hands-on activities (ledger posting, model building, statement tracing, sorting, forensic investigations and slider labs with goals). Open it in any browser; no build step, no dependencies (fonts load from Google Fonts with system fallbacks).

## Structure inside `index.html`

1. `<style>`: design tokens and components (dark by default, light theme in Progress → Settings).
2. **COURSE CONTENT** `<script>`: `window.COURSE.modules`, all curriculum data. The comment at the top of that block documents the module, lesson, card and question shapes.
3. **APP ENGINE** `<script>`: router, card player, question types, spaced repetition, views and interactive tools. Adding a module never requires editing this block.

## Adding a module

Replace the placeholder object for that module (it has `status: 'locked'` and an `outline`) with a full object shaped like Module 1: `lessons`, `quiz`, `formulas`, `glossary`. Question `id`s must be unique and stable, because progress and the review queue are keyed on them.

## Progress

Saved in the browser's `localStorage` (key `buyside-curriculum-v1`). Each origin (a local file, a hosted copy) keeps its own progress; use Progress → "Show my progress code" to move it between them.
