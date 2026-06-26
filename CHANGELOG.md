# Changelog

## [Unreleased]

### Added
- Initial standalone `apply_patch` pi extension.
- Context-aware diff truncation with ... markers for pi-style edit format
- Path normalization for ~, file://, and unicode spaces

### Changed
- Path resolution relaxed to allow patches targeting files outside cwd
- Render output shows contextual titles (Applied patch, Patch partially failed) with error background
- Tests updated: outside-path tests expect success instead of rejection
- Refactored apply_patch render system with stateful ApplyPatchCallRenderComponent for lifecycle-aware call/result rendering
- Updated pending update text format to show file-specific patch targets with progress counters

### Removed
- Removed workspace boundary checks (isPathWithinWorkspace, findExistingAncestor)