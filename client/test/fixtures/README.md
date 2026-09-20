# Baseline wire messages

`baseline-guest-session.json` contains Socket.IO messages received by a synthetic guest from
the actual server at commit `34d68dbbb3f15d5c68a00975021478a15ce9c0b6`. The compatibility
browser journey captured them on 2026-09-14, covering join, first round, clue, guess, reveal,
pause, page reload/reconnect, resume and round two. Room codes, reconnect credentials and
generated player identifiers are replaced consistently. The room ran locally in memory;
no production player data is present. Card choice, angles and deadlines are the captured values.

The client replay tests consume this committed fixture. Normal browser tests never rewrite it.
The capture tooling and original revision remain in the private development repository.
This snapshot runs replay tests directly from the sanitized fixture without Git history.
Do not regenerate it merely to make a replay failure pass.
