const os = require('os');

const ifaces = os.networkInterfaces();
const interfaces = Object.values(ifaces)
  .reduce((r, a) => {
    r = r.concat(a);
    return r;
  }, [])
  .filter(({ family, internal }) => !internal && family.toLowerCase() === 'ipv4')
  .map(({ address }) => address);

module.exports.interfaces = interfaces;
module.exports.ifaces = ifaces;
