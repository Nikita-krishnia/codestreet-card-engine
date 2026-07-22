# TODO: Fix History Refresh Shaking

- [x] Plan approved by user
- [ ] **CSS Changes:**
  - [x] Remove `slideIn` animation from `.history-item` (main cause)
  - [x] Add `contain: content` to `.history-list` (isolate reflows)
  - [x] Add `.history-item.new-item` class with subtle fade-in animation for new items
  - [x] Add `will-change` to stable container elements
- [ ] **JS Changes:**
  - [x] Add data comparison (hash check before re-render)
  - [x] Identify newly added items and apply `.new-item` class
  - [x] Remove `.new-item` class after animation completes
- [x] Done ✅

