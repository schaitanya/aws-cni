const AWS = require('aws-sdk');
const Debug = require('debug');

const { interfaces } = require('./interfaces');
const { InstanceENIsAvailable, InstanceIPsAvailable } = require('./vpcLimits');

const debug = Debug('aws-cni:aws');

AWS.config.update({ region: 'us-east-1' });
const ec2 = new AWS.EC2();

class AWSService {
  /**
   * Constructor.
   */
  constructor() {
    this.hasInitialized = false;
  }

  /**
   * Initalize the service.
   * @returns {this}
   */
  async init() {
    if (this.hasInitialized) {
      return;
    }

    this.metadataService = new AWS.MetadataService();
    this.instanceId = await this.getInstancId();
    this.instance = await this.getInstance();
    await this.describeAddresses();

    this.hasInitialized = true;
  }

  /**
   * Create a new Network Interface.
   * @param {number} deviceIndex - Device index to attach.
   * @param {number} limit - Number of private ips on the interface.
   * @returns {void}
   */
  async createENI(deviceIndex, limit) {
    const { SubnetId, InstanceId, SecurityGroups } = this.instance;
    const securityGroups = SecurityGroups.map((sg) => sg.GroupId);
    const params = {
      SubnetId,
      Description: 'AUTO',
      SecondaryPrivateIpAddressCount: limit - 1, // Account for the primary
      Groups: securityGroups,
    };

    const newInterface = await ec2.createNetworkInterface(params).promise();
    const attachParams = {
      DeviceIndex: deviceIndex,
      InstanceId,
      NetworkInterfaceId: newInterface.NetworkInterface.NetworkInterfaceId,
    };
    console.log('Attaching...');
    await ec2.attachNetworkInterface(attachParams).promise();
    await this.allocateAddressToInterface(newInterface.NetworkInterface);
  }

  /**
   * Check if the instance has correct number of ENI and Private Addresses.
   * @returns {void}
   */
  async checkIfInstanceHasValidInterfaces() {
    await this.init();
    const eniLimit = InstanceENIsAvailable[this.instance.InstanceType];
    const ipLimitPerEni = InstanceIPsAvailable[this.instance.InstanceType];
    const currentInterfaces = this.instance.NetworkInterfaces;

    for (const newtorkInterface of currentInterfaces) {
      const attachedIps = newtorkInterface.PrivateIpAddresses.length;

      if (attachedIps < ipLimitPerEni) {
        await this.assignAndAllocatePrivateIpAddress(newtorkInterface, ipLimitPerEni - attachedIps);
      }

      // check if any local address has no associated elastic ip
      const noAssociatedIpAddresses = newtorkInterface.PrivateIpAddresses.filter((privateIpAddresses) => {
        return !privateIpAddresses.Association;
      });

      if (noAssociatedIpAddresses.length) {
        await this.allocateAddressToInterface(newtorkInterface);
      }
    }

    let deviceIdx = currentInterfaces.length;

    if (eniLimit > currentInterfaces.length) {
      while (deviceIdx !== eniLimit) {
        ++deviceIdx;
        debug('Creating ENI');
        await this.createEni(deviceIdx - 1, ipLimitPerEni);
      }
    }
  }

  /**
   * Assign private addresses and elastic ips.
   * @param {AWS.EC2.NetworkInterface} newtorkInterface - Network Interface.
   * @param {number} limit - Number of private ips on the interface.
   * @returns {void}
   */
  async assignAndAllocatePrivateIpAddress(newtorkInterface, limit) {
    const params = {
      NetworkInterfaceId: newtorkInterface.NetworkInterfaceId,
      SecondaryPrivateIpAddressCount: limit,
    };

    await ec2.assignPrivateIpAddresses(params).promise();
    const fetchInterfaceParams = {
      NetworkInterfaceIds: [newtorkInterface.NetworkInterfaceId],
    };

    const refereshedInterface = await ec2.describeNetworkInterfaces(fetchInterfaceParams).promise();
    await this.allocateAddressToInterface(refereshedInterface[0]);
  }

  /**
   * Create a new EIP if the private has no associated EIP.
   * @param {AWS.EC2.NetworkInterface} newtorkInterface - Network Interface.
   * @returns {void}
   */
  async allocateAddressToInterface(newtorkInterface) {
    for (const privateIpAddress of newtorkInterface.PrivateIpAddresses) {
      if (!privateIpAddress.Association) {

        const allocation = await this.allocateAddress();
        await this.assocateAddress(newtorkInterface, allocation, privateIpAddress.PrivateIpAddress);
      }
    }
  }

  /* eslint-disable class-methods-use-this */
  /**
   * Allocate a new EIP.
   * @returns {Promise<AWS.EC2.AllocateAddressRequest>} Allocation.
   */
  async allocateAddress() {
    const params = {
      Domain: 'vpc',
    };

    const allocation = await ec2.allocateAddress(params).promise();

    return allocation;
  }
  /* eslint-enable */

  /* eslint-disable class-methods-use-this */
  /**
   * Associate Elastic IP to a private IP on an interface.
   * @param {AWS.EC2.NetworkInterface} newtorkInterface - Network Interface.
   * @param {AWS.EC2.AllocateAddressResult} allocation - EIP Allocation.
   * @param {AWS.EC2.NetworkInterface.PrivateIpAddresses.privateIpAddress} privateIpAddress - Private address to allocate to.
   * @returns {AWS.EC2.AssociateAddressResult}
   */
  async assocateAddress(newtorkInterface, allocation, privateIpAddress) {
    const params = {
      NetworkInterfaceId: newtorkInterface.NetworkInterfaceId,
      AllocationId: allocation.AllocationId,
      PrivateIpAddress: privateIpAddress,
    };

    const response = await ec2.associateAddress(params).promise();
    return response;
  }
  /* eslint-enable */


  /**
   * Get Private/Elastic IPs associated to current instance.
   * @returns {AWS.EC2.DescribeAddressesResult}
   */
  async describeAddresses() {
    debug(`describeAddress: ${this.instanceId}`);

    const params = {
      Filters: [{
        Name: 'instance-id',
        Values: [this.instanceId],
      }],
    };

    const response = await ec2.describeAddresses(params).promise();
    this.addresses = response.Addresses.reduce((r, a) => {
      r[a.PrivateIpAddress] = a;
      return r;
    }, {});
  }

  /**
   * Get the current Instance details.
   * @returns {AWS.EC2.Instance} Current Instance.
   */
  async getInstance() {
    const response = await ec2.describeInstances({
      InstanceIds: [this.instanceId],
    }).promise();

    return response.Reservations[0].Instances[0];
  }

  /**
   * Get current instance id.
   * @returns {Promise<string>}
   */
  async getInstancId() {
    return this.getMetadata('instance-id');
  }

  /**
   * Detach EIP from the interface and release it.
   * @param {AWS.EC2.NetworkInterface.PrivateIpAddress} privateIpAddress - Private Address.
   * @param {boolean} reattach - Set to true to create a new one.
   * @returns {void}
   */
  async removeAddress(privateIpAddress, reattach = false) {
    if (interfaces[0] === privateIpAddress) {
      console.log('Unable to remove primary ip');
      return;
    }

    await this.disassociateAddress(privateIpAddress);
    await this.releaseAddress(privateIpAddress);

    if (reattach) {
      const fetchInterfaceParams = {
        NetworkInterfaceIds: [this.addresses[privateIpAddress].NetworkInterfaceId],
      };

      const interfaceWithAddress = await ec2.describeNetworkInterfaces(fetchInterfaceParams).promise();
      const allocation = await this.allocateAddress();
      await this.assocateAddress(interfaceWithAddress, allocation, privateIpAddress);
    }
  }

  /**
   * Detach EIP from the interface.
   * @param {AWS.EC2.NetworkInterface.PrivateIpAddress} privateIpAddress - Private Address.
   * @returns {void}
   */
  async disassociateAddress(privateIpAddress) {
    debug(`disassociateAddress: ${privateIpAddress}`);
    // const fetchInterfaceParams = {
    //   NetworkInterfaceIds: [this.addresses[privateIpAddress].NetworkInterfaceId],
    // };

    // console.log(fetchInterfaceParams);

    // const interfaceWithAddress = await ec2.describeNetworkInterfaces(fetchInterfaceParams).promise();
    // await this.allocateAddress(interfaceWithAddress);
    const address = this.addresses[privateIpAddress];
    const params = {
      AssociationId: address.AssociationId,
      // PublicIp: address.PublicIp,
    };

    const response = await ec2.disassociateAddress(params).promise();
    return response;
  }

  /**
   * Release EIP.
   * @param {AWS.EC2.NetworkInterface.PrivateIpAddress} privateIpAddress - Private Address.
   * @returns {void}
   */
  async releaseAddress(privateIpAddress) {
    debug(`ReleaseAddress: ${privateIpAddress}`);
    const address = this.addresses[privateIpAddress];
    const params = {
      AllocationId: address.AllocationId,
      // PublicIp: address.PublicIp,
    };

    const response = await ec2.releaseAddress(params).promise();
    return response;
  }

  /**
   * Get instance metadata.
   * @param {string} path - Metadata path.
   * @param {string} method - Request method.
   * @returns {Promise<string|Object>} Requested metadata.
   */
  async getMetadata(path, method = 'GET') {
    return new Promise((resolve, reject) => {
      return this.metadataService.request(`/latest/meta-data/${path}`, {
        method,
      }, (err, metadata) => {
        if (err) {
          return reject(err);
        }
        return resolve(metadata);
      });
    });
  }
}


module.exports = AWSService;
