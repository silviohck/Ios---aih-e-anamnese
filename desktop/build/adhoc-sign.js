// Assina o app com assinatura local (ad-hoc) depois de empacotar.
// Sem isso, Macs com Apple Silicon dizem que o app "está danificado".
// Quando houver certificado de desenvolvedor Apple, trocar por assinatura real.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
