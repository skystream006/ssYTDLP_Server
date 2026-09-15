import fs from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import selfsigned from 'selfsigned';

function certificateName(value) {
  const name = String(value || '').trim();
  return name && !name.includes(':') ? name : 'localhost';
}

function subjectAltName(value) {
  return net.isIP(value) ? { type: 7, ip: value } : { type: 2, value };
}

export async function loadHttpsOptions() {
  const configuredKeyPath = process.env.HTTPS_KEY_PATH;
  const configuredCertPath = process.env.HTTPS_CERT_PATH;
  if (Boolean(configuredKeyPath) !== Boolean(configuredCertPath)) {
    throw new Error('HTTPS_KEY_PATH and HTTPS_CERT_PATH must be configured together');
  }

  if (configuredKeyPath && configuredCertPath) {
    return {
      key: await fs.readFile(path.resolve(configuredKeyPath)),
      cert: await fs.readFile(path.resolve(configuredCertPath))
    };
  }

  const certificateDirectory = path.resolve(process.cwd(), 'data', 'tls');
  const keyPath = path.join(certificateDirectory, 'server-key.pem');
  const certPath = path.join(certificateDirectory, 'server-cert.pem');
  const host = certificateName(process.env.PASSKEY_RP_ID);
  try {
    const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    const certificate = new X509Certificate(cert);
    const matchesHost = net.isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host);
    if (matchesHost) return { key, cert };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const names = [...new Set([host, 'localhost', '127.0.0.1', '::1'])];
  const certificates = await selfsigned.generate(
    [{ name: 'commonName', value: host }],
    {
      algorithm: 'sha256',
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: names.map(subjectAltName) }
      ]
    }
  );
  await fs.mkdir(certificateDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(keyPath, certificates.private, { mode: 0o600 }),
    fs.writeFile(certPath, certificates.cert)
  ]);
  console.log(`Generated local HTTPS certificate at ${certPath}`);
  return { key: certificates.private, cert: certificates.cert };
}