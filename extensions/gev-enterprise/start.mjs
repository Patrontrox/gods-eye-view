#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { startEnterpriseGateway } from './gateway.mjs';
const required = (name) => {
  const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value;
};
try {
  const path = process.env.GEV_CONNECTOR_MANIFEST;
  const connectors = path ? JSON.parse(readFileSync(path, 'utf8')) : [];
  startEnterpriseGateway({
    publicOrigin: required('GEV_PUBLIC_ORIGIN'), issuer: required('GEV_OIDC_ISSUER'),
    clientId: required('GEV_OIDC_CLIENT_ID'), jwksUri: required('GEV_OIDC_JWKS_URI'),
    authorizationEndpoint: required('GEV_OIDC_AUTHORIZATION_ENDPOINT'), tokenEndpoint: required('GEV_OIDC_TOKEN_ENDPOINT'),
    clientSecret: process.env.GEV_OIDC_CLIENT_SECRET,
    rolesClaim: process.env.GEV_OIDC_ROLES_CLAIM || 'roles',
    aemetApiKey: process.env.AEMET_API_KEY,
    otAggregateFile: process.env.GEV_OT_AGGREGATE_FILE,
    connectors,
    port: process.env.GEV_ENTERPRISE_PORT || 4474,
  });
} catch (error) { console.error(`[GEV Enterprise] Cannot start: ${error.message}`); process.exitCode = 1; }
