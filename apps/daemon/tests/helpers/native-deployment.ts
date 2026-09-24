import { setup } from './native-cynder.js';
import { NativeCynderConsumer } from '../../src/foldy-deployments/native-cynder.js';
import { NativeDeploymentService, type HostingAdmission, type NativeDeploymentRequest } from '../../src/foldy-deployments/native-deployment-service.js';
export async function serviceSetup() {
  const s = await setup({ admittedActions: ['DEPLOY'] });
  const request: NativeDeploymentRequest = { schemaVersion: 'foldy-native-deployment.v1',
    release: { instanceId: 'instance-1', projectId: 'project-1', workbookId: 'book-1', revisionId: 'rev-1',
      releaseBundleDigest: 'sha256:' + 'b'.repeat(64), imageDigest: 'registry.example/app@sha256:' + 'a'.repeat(64) },
    idempotencyKey: 'service-1', hostingAdmissionRef: 'admission-1', budget: s.budget };
  const admission: HostingAdmission = { admissionRef: request.hostingAdmissionRef, contractDigest: 'd'.repeat(64),
    release: request.release, ownerPrincipalId: 'owner-1', origin: s.config.origin, validUntil: '2099-01-01T00:00:00Z',
    durableStorage: { volumeIdentity: 'volume-1', mountPath: '/data', retentionContractRef: 'retention-1' },
    bootstrap: { mode: 'sealed-one-use-owner', protectedCustodyRef: 'bootstrap-1', ownerPrincipalId: 'owner-1' },
    singleWriter: { mode: 'exclusive-fenced', fenceContractRef: 'fence-1' },
    transport: { mode: 'https-streamable-http', routeContractRef: 'route-1', authenticationContractRef: 'auth-1' },
    nativeRequest: { type: 'DEPLOY', image_digest: request.release.imageDigest, resource_class: 'mvi-small' } };
  const make = () => new NativeDeploymentService({ consumer: new NativeCynderConsumer(s.config), dataRoot: s.dir, origin: s.config.origin,
    requireOwner: async (session: string) => { if (session !== 'authenticated-owner') throw new Error('AUTH_REQUIRED'); return { principalId: 'owner-1', sessionId: 'session-1' }; },
    resolveAdmission: async () => admission });
  return { ...s, request, admission, make, service: make() };
}
