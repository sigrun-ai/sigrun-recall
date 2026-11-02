# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### TODO

- Pin `@sigrun/sigrun` and `@sigrun/shared` to the released core version carrying C1 once it ships, replacing their development `file:` specifiers.

### Added

- Initial `@sigrun/recall` extension package and factory skeleton.
- Idempotent SQLite schema for indexed items, contentless porter and trigram FTS indexes, artifacts, cursors, confidentiality taint, injections, and optional vectors.
- Extension-wide and per-user settings resolution with documented defaults and safe fallback for invalid values.
