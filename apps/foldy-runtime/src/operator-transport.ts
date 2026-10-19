/** Stable operator entry point; host paths and credentials are operator inputs. */
export { privateFile, parseRequest, checkedRuntimeStatus, checkedHealth, localHealthUrl, canonicalHealthUrl, loopbackHealth, writePrivate, nativeRunner, operatorTransport } from './operator-driver.js';
export type { TransportRequest, Runner, DriverDependencies, HealthProbe } from './operator-driver.js';
export type { TransportObservation as TransportEvidence } from './transport-observation.js';
