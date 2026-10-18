# Security boundary

This is a private, experimental host integration. There is no published support or security-audit
claim. Report vulnerabilities privately to the repository owner using the repository's configured
private reporting channel when available. No public contact address is currently configured.

Task workers and candidate tools execute code. Linux bubblewrap confines filesystem access;
the host and independent verifiers remain trusted. A shared kernel is not a hostile-tenant boundary.
Do not mount secrets or private suite files into worker references. Candidate artifacts and logs
may contain untrusted text; reviewers must follow frozen contracts and host-issued evidence.

Model credentials stay in the operator's private DSH home. CI must not expose credentials or execute
untrusted pull-request code on an internal host. Native experiments are explicit operator actions.
