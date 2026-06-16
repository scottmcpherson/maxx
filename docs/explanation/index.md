---
layout: doc
title: Explanation
description: Design rationale and product boundaries for Maxx.
permalink: /docs/explanation/
section: explanation
---

# Explanation

These docs explain why Maxx's control plane is intentionally narrow and explicit.

<div class="section-grid">
  <a class="section-card" href="{{ '/no-inference.html' | relative_url }}">
    <h2>No-inference rule</h2>
    <p>Maxx displays mechanical facts and agent-declared facts, but never invents workflow truth.</p>
  </a>
  <a class="section-card" href="{{ '/docs/explanation/security-model/' | relative_url }}">
    <h2>Security model</h2>
    <p>Local sockets, capability tokens, policy checks, and webhook trust boundaries.</p>
  </a>
</div>
