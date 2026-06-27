# Changelog

## [Unreleased]

### Added
- Initial standalone `apply_patch` pi extension.
- Context-aware diff truncation with ... markers for pi-style edit format
- Path normalization for ~, file://, and unicode spaces
- Added test verifying uniform line width in ANSI-styled diff output
- Added `renderShell: "self"` to apply_patch tool definition for self-managed shell rendering

### Changed
- Path resolution relaxed to allow patches targeting files outside cwd
- Render output shows contextual titles (Applied patch, Patch partially failed) with error background
- Tests updated: outside-path tests expect success instead of rejection
- Refactored apply_patch render system with stateful ApplyPatchCallRenderComponent for lifecycle-aware call/result rendering
- Updated pending update text format to show file-specific patch targets with progress counters
- Applied theme-aware rendering to call title with foreground/bold styling
- Moved result text display into the call component with lifecycle management
- Removed per-diff-line background colors, retaining only foreground diff colors
- Replaced Unicode ellipsis truncation marker with ASCII ... and added line-number padding to truncation lines
- Simplified background rendering by replacing `applyLayeredBackground` helper with direct `theme.bg()` calls
- Removed line-bounded truncation from truncatePreview; now restricts previews only by character count

### Removed
- Removed workspace boundary checks (isPathWithinWorkspace, findExistingAncestor)
- Removed `applyLayeredBackground` utility function
- Removed PATCH_PREVIEW_MAX_LINES constant and associated line-window truncation helper functions

### Fixed
- Relaxed parseRenderableDiffLine regex to accept empty line numbers for truncation lines
- Context line numbers in createPatchDiff now use new-file line numbers instead of original file line numbers
- Fixed nested background reset gap in ANSI output by allowing tool to manage its own shell