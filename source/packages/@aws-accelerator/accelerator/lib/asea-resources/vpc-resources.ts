import * as cdk from 'aws-cdk-lib';
import { pascalCase } from 'pascal-case';
import { IPv4CidrRange, IPv6CidrRange } from 'ip-num';

import {
  CfnInternetGateway,
  CfnNatGateway,
  CfnRouteTable,
  CfnSecurityGroup,
  CfnSubnet,
  CfnTransitGatewayAttachment,
  CfnVPC,
  CfnVPNGateway,
} from 'aws-cdk-lib/aws-ec2';

import {
  FirewallPolicyProperty,
  NetworkFirewall,
  NetworkFirewallPolicy,
  NetworkFirewallRuleGroup,
} from '@aws-accelerator/constructs';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import {
  AseaStackInfo,
  VpcConfig,
  VpcTemplatesConfig,
  AseaResourceType,
  NfwFirewallConfig,
  NfwStatefulRuleGroupReferenceConfig,
  RouteTableConfig,
  TransitGatewayAttachmentConfig,
  SecurityGroupRuleConfig,
  nonEmptyString,
  NetworkConfigTypes,
} from '@aws-accelerator/config';
import { SsmResourceType } from '@aws-accelerator/utils';
import { ImportAseaResourcesStack, LogLevel } from '../stacks/import-asea-resources-stack';
import { AseaResource, AseaResourceProps } from './resource';
import { getSubnetConfig, getVpcConfig } from '../stacks/network-stacks/utils/getter-utils';

const enum RESOURCE_TYPE {
  VPC = 'AWS::EC2::VPC',
  SUBNET = 'AWS::EC2::Subnet',
  CIDR_BLOCK = 'AWS::EC2::VPCCidrBlock',
  INTERNET_GATEWAY = 'AWS::EC2::InternetGateway',
  NAT_GATEWAY = 'AWS::EC2::NatGateway',
  VPN_GATEWAY = 'AWS::EC2::VPNGateway',
  SECURITY_GROUP = 'AWS::EC2::SecurityGroup',
  SECURITY_GROUP_EGRESS = 'AWS::EC2::SecurityGroupEgress',
  SECURITY_GROUP_INGRESS = 'AWS::EC2::SecurityGroupIngress',
  ROUTE_TABLE = 'AWS::EC2::RouteTable',
  TGW_ATTACHMENT = 'AWS::EC2::TransitGatewayAttachment',
  TGW_ASSOCIATION = 'AWS::EC2::TransitGatewayRouteTableAssociation',
  TGW_PROPAGATION = 'AWS::EC2::TransitGatewayRouteTablePropagation',
  TGW_ROUTE = 'AWS::EC2::TransitGatewayRoute',
  NETWORK_FIREWALL = 'AWS::NetworkFirewall::Firewall',
  NETWORK_FIREWALL_POLICY = 'AWS::NetworkFirewall::FirewallPolicy',
  NETWORK_FIREWALL_RULE_GROUP = 'AWS::NetworkFirewall::RuleGroup',
  NETWORK_FIREWALL_LOGGING = 'AWS::NetworkFirewall::LoggingConfiguration',
  VPC_ENDPOINT = 'AWS::EC2::VPCEndpoint',
  TRANSIT_GATEWAY_ROUTE_TABLE = 'AWS::EC2::TransitGatewayRouteTable',
}

const TCP_PROTOCOLS_PORT: { [key: string]: number } = {
  RDP: 3389,
  SSH: 22,
  HTTP: 80,
  HTTPS: 443,
  MSSQL: 1433,
  'MYSQL/AURORA': 3306,
  REDSHIFT: 5439,
  POSTGRESQL: 5432,
  'ORACLE-RDS': 1521,
};

const ASEA_PHASE_NUMBER = 1;

type NestedAseaStackInfo = AseaStackInfo & { logicalResourceId: string };

export interface VpcResourcesProps extends AseaResourceProps {
  /**
   * Nested Stacks of current phase stack
   */
  nestedStacksInfo: NestedAseaStackInfo[];
}

export class VpcResources extends AseaResource {
  private readonly nestedStacksInfo: NestedAseaStackInfo[] = [];
  private readonly props: VpcResourcesProps;
  private ssmParameters: { logicalId: string; parameterName: string; stringValue: string }[];
  constructor(scope: ImportAseaResourcesStack, props: VpcResourcesProps) {
    super(scope, props);
    this.props = props;
    this.ssmParameters = [];
    if (props.stackInfo.phase !== ASEA_PHASE_NUMBER) {
      this.scope.addLogs(LogLevel.INFO, `No ${RESOURCE_TYPE.VPC}s to handle in stack ${props.stackInfo.stackName}`);
      return;
    }
    this.nestedStacksInfo = props.nestedStacksInfo;
    const vpcsInScope = this.scope.vpcsInScope;
    for (const vpcInScope of vpcsInScope) {
      // ASEA creates NestedStack for each VPC. All SSM Parameters related to VPC goes to nested stack
      this.ssmParameters = [];
      const vpcResourceInfo = this.getVpcResourceByTag(vpcInScope.name);
      if (!vpcResourceInfo) {
        this.scope.addLogs(
          LogLevel.INFO,
          `Item Excluded: ${vpcInScope.name} in Account/Region ${props.stackInfo.accountKey}/${props.stackInfo.region}`,
        );
        continue;
      }
      const { stackInfo: vpcStackInfo, resource } = vpcResourceInfo;
      const nestedStack = this.stack.getNestedStack(vpcStackInfo.logicalResourceId);
      // This is retrieved the specific VPC resource is loaded so we can modify attributes
      const vpc = nestedStack.includedTemplate.getResource(resource.logicalResourceId) as CfnVPC;
      this.setupInternetGateway(vpcStackInfo, nestedStack, vpcInScope);
      this.setupVpnGateway(vpcStackInfo, nestedStack, vpcInScope);
      // This modifies ASEA vpc attributes to match LZA config
      vpc.cidrBlock = vpcInScope.cidrs![0]; // 0th index is always main cidr Block
      vpc.enableDnsHostnames = vpcInScope.enableDnsHostnames;
      vpc.enableDnsSupport = vpcInScope.enableDnsSupport;
      vpc.instanceTenancy = vpcInScope.instanceTenancy;
      if (vpcInScope.cidrs!.length > 1) {
        const additionalCidrResources = this.getAdditionalCidrs(vpcStackInfo);
        const existingAdditionalCidrBlocks: string[] = additionalCidrResources.map(
          cfnResource => cfnResource.resourceMetadata['Properties'].CidrBlock,
        );
        vpcInScope.cidrs!.slice(1).forEach(cidr => {
          const additionalCidrResource = additionalCidrResources.find(
            cfnResource => cfnResource.resourceMetadata['Properties'].CidrBlock === cidr,
          );
          if (!additionalCidrResource) {
            this.scope.addLogs(
              LogLevel.INFO,
              `Item Excluded: ${vpcInScope.name} CIDR in Account/Region ${props.stackInfo.accountKey}/${props.stackInfo.region}`,
            );
            return;
          }
          this.scope.addAseaResource(AseaResourceType.EC2_VPC_CIDR, `${vpcInScope.name}-${cidr}`);
        });
        const removedAseaCidrs = vpcInScope
          .cidrs!.slice(1)
          .filter(cidr => !existingAdditionalCidrBlocks.includes(cidr));
        this.scope.addLogs(LogLevel.INFO, `Removed Additional CIDR created by ASEA are ${removedAseaCidrs}`);
      }
      // Create Subnets takes in an LZA VPC Config as 'vpcInScope' object and Existing ASEA stack resource information as 'vpcStackInfo'
      const subnets = this.createSubnets(vpcInScope, vpcStackInfo, nestedStack.includedTemplate);
      this.createNatGateways(vpcStackInfo, nestedStack.includedTemplate, vpcInScope, subnets);
      this.createSecurityGroups(vpcInScope, vpcStackInfo, nestedStack.includedTemplate);
      const tgwAttachmentMap = this.createTransitGatewayAttachments(
        vpcInScope,
        vpcStackInfo,
        nestedStack.includedTemplate,
        subnets,
      );
      this.createTransitGatewayRouteTablePropagation(
        vpcInScope,
        vpcStackInfo,
        nestedStack.includedTemplate,
        tgwAttachmentMap ?? {},
      );
      this.createTransitGatewayRouteTableAssociation(
        vpcInScope,
        vpcStackInfo,
        nestedStack.includedTemplate,
        tgwAttachmentMap ?? {},
      );
      this.createNetworkFirewallResources(vpcInScope, vpcStackInfo, nestedStack.includedTemplate, vpc.ref, subnets);
      this.gatewayEndpoints(vpcInScope, vpcStackInfo, nestedStack.includedTemplate);
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcInScope.name)}VpcId`),
        parameterName: this.scope.getSsmPath(SsmResourceType.VPC, [vpcInScope.name]),
        stringValue: vpc.ref,
      });
      this.scope.addAseaResource(AseaResourceType.EC2_VPC, vpcInScope.name);
      this.createSsmParameters(nestedStack.includedTemplate);
    }
  }

  private addSsmParameter(props: { logicalId: string; parameterName: string; stringValue: string }) {
    this.ssmParameters.push({
      logicalId: props.logicalId,
      parameterName: props.parameterName,
      stringValue: props.stringValue,
    });
  }

  /**
   * This method creates SSM parameters stored in the `NestedStack.ssmParameters` array.
   * If more than five parameters are defined, the method adds a `dependsOn` statement
   * to remaining parameters in order to avoid API throttling issues.
   */
  private createSsmParameters(scope: CfnInclude): void {
    let index = 1;
    const parameterMap = new Map<number, cdk.aws_ssm.StringParameter>();

    for (const parameterItem of this.ssmParameters) {
      // Create parameter
      const parameter = new cdk.aws_ssm.StringParameter(scope, parameterItem.logicalId, {
        parameterName: parameterItem.parameterName,
        stringValue: parameterItem.stringValue,
      });
      parameterMap.set(index, parameter);

      // Add a dependency for every 5 parameters
      if (index > 5) {
        const dependsOnParam = parameterMap.get(index - (index % 5));
        if (!dependsOnParam) {
          this.scope.addLogs(
            LogLevel.ERROR,
            `Error creating SSM parameter ${parameterItem.parameterName}: previous SSM parameter undefined`,
          );
          throw new Error(`Configuration validation failed at runtime.`);
        }
        parameter.node.addDependency(dependsOnParam);
      }
      // Increment index
      index += 1;
    }
  }

  private setupInternetGateway(
    vpcStackInfo: NestedAseaStackInfo,
    nestedStack: cdk.cloudformation_include.IncludedNestedStack,
    vpcConfig: VpcConfig | VpcTemplatesConfig,
  ) {
    const internetGatewayInfo = vpcStackInfo.resources.filter(
      cfnResource => cfnResource.resourceType === RESOURCE_TYPE.INTERNET_GATEWAY,
    )?.[0];
    if (vpcConfig.internetGateway && internetGatewayInfo) {
      const internetGateway = nestedStack.includedTemplate.getResource(
        internetGatewayInfo.logicalResourceId,
      ) as CfnInternetGateway;
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcConfig.name)}InternetGatewayId`),
        parameterName: this.scope.getSsmPath(SsmResourceType.IGW, [vpcConfig.name]),
        stringValue: internetGateway.ref,
      });
      this.scope.addAseaResource(AseaResourceType.EC2_IGW, vpcConfig.name);
    }
  }

  private setupVpnGateway(
    vpcStackInfo: NestedAseaStackInfo,
    nestedStack: cdk.cloudformation_include.IncludedNestedStack,
    vpcConfig: VpcConfig | VpcTemplatesConfig,
  ) {
    const virtualPrivateGatewayInfo = vpcStackInfo.resources.filter(
      cfnResource => cfnResource.resourceType === RESOURCE_TYPE.VPN_GATEWAY,
    )?.[0];
    if (vpcConfig.virtualPrivateGateway && virtualPrivateGatewayInfo) {
      const virtualPrivateGateway = nestedStack.includedTemplate.getResource(
        virtualPrivateGatewayInfo.logicalResourceId,
      ) as CfnVPNGateway;
      virtualPrivateGateway.amazonSideAsn = vpcConfig.virtualPrivateGateway.asn;
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcConfig.name)}VirtualPrivateGatewayId`),
        parameterName: this.scope.getSsmPath(SsmResourceType.VPN_GW, [vpcConfig.name]),
        stringValue: virtualPrivateGateway.ref,
      });
      this.scope.addAseaResource(AseaResourceType.EC2_VPN_GW, vpcConfig.name);
    }
  }

  private createNatGateways(
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    subnets: { [name: string]: CfnSubnet },
  ) {
    const natGatewayResources = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.NAT_GATEWAY);
    if (vpcItem.natGateways?.length === 0 && natGatewayResources.length > 0) {
      this.scope.addLogs(LogLevel.WARN, `NAT Gateways are removed from configuration.`);
      return;
    }
    for (const natGatewayItem of vpcItem.natGateways ?? []) {
      const natGatewayResource = this.findResourceByTag(natGatewayResources, natGatewayItem.name);
      if (!natGatewayResource) continue; // NAT Gateway is not managed by ASEA
      const natGateway = vpcStack.getResource(natGatewayResource.logicalResourceId) as CfnNatGateway;
      let subnetId = subnets[natGatewayItem.subnet].ref;
      if (!subnetId) {
        subnetId = this.scope.getExternalResourceParameter(
          this.scope.getSsmPath(SsmResourceType.SUBNET, [vpcItem.name, natGateway.subnetId]),
        );
      }
      if (subnetId) {
        // Update SubnetId only if subnet is created
        natGateway.subnetId = subnetId;
      }
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(natGatewayItem.name)}NatGatewayId`),
        parameterName: this.scope.getSsmPath(SsmResourceType.NAT_GW, [vpcItem.name, natGatewayItem.name]),
        stringValue: natGateway.ref,
      });
      this.scope.addAseaResource(AseaResourceType.NAT_GATEWAY, `${vpcItem.name}/${natGatewayItem.name}`);
    }
  }

  private createSubnets(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
  ) {
    const subnets: { [name: string]: CfnSubnet } = {};
    for (const subnetItem of vpcItem.subnets ?? []) {
      const subnetResource = this.getSubnetResourceByTag(subnetItem.name, vpcStackInfo);
      if (!subnetResource) continue;
      const subnet = vpcStack.getResource(subnetResource.logicalResourceId) as CfnSubnet;
      subnet.cidrBlock = subnetItem.ipv4CidrBlock;
      // LZA Config accepts only 'a' for 'us-east-1a' or integer
      subnet.availabilityZone = `${vpcItem.region}${subnetItem.availabilityZone}`;
      subnet.mapPublicIpOnLaunch = subnetItem.mapPublicIpOnLaunch;
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(subnetItem.name)}SubnetId`),
        parameterName: this.scope.getSsmPath(SsmResourceType.SUBNET, [vpcItem.name, subnetItem.name]),
        stringValue: subnet.ref,
      });
      this.scope.addAseaResource(AseaResourceType.EC2_SUBNET, `${vpcItem.name}/${subnetItem.name}`);
      subnets[subnetItem.name] = subnet;
    }
    return subnets;
  }

  private createSecurityGroups(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
  ) {
    const securityGroupsMap = new Map<string, string>();
    const securityGroupPhysicalIdMap = new Map<string, string>();

    type SecurityGroupRuleInfo = {
      protocol: string;
      source: string;
      sourceValue: string;
      type?: string;
      to?: number;
      from?: number;
      sourceType?: string;
      description?: string;
    };
    const processSecurityGroupSources = (
      securityGroupRuleItem: SecurityGroupRuleConfig,
      ruleProps: {
        protocol: cdk.aws_ec2.Protocol;
        type?: string;
        from?: number;
        to?: number;
      },
    ) => {
      const securityGroupRules: SecurityGroupRuleInfo[] = [];
      securityGroupRuleItem.sources.forEach(sourceItem => {
        if (nonEmptyString.is(sourceItem))
          securityGroupRules.push({
            ...ruleProps,
            source: sourceItem,
            sourceValue: sourceItem,
            description: securityGroupRuleItem.description,
          });
        if (NetworkConfigTypes.subnetSourceConfig.is(sourceItem)) {
          const sourceVpcItem = getVpcConfig(this.scope.vpcsInScope, sourceItem.vpc);
          sourceItem.subnets.forEach(subnet =>
            securityGroupRules.push({
              ...ruleProps,
              source: `${sourceVpcItem.name}/${subnet}`,
              sourceValue: getSubnetConfig(sourceVpcItem, subnet).ipv4CidrBlock!,
              sourceType: 'subnet',
              description: securityGroupRuleItem.description,
            }),
          );
        }
        if (NetworkConfigTypes.securityGroupSourceConfig.is(sourceItem)) {
          sourceItem.securityGroups.forEach(securityGroup => {
            if (!securityGroupsMap.get(securityGroup)) return;
            securityGroupRules.push({
              ...ruleProps,
              source: securityGroup,
              sourceValue: securityGroupsMap.get(securityGroup)!,
              sourceType: 'sg',
              description: securityGroupRuleItem.description,
            });
          });
        }
      });
      return securityGroupRules;
    };
    const processTcpSources = (securityGroupRuleItem: SecurityGroupRuleConfig) => {
      const securityGroupRules: SecurityGroupRuleInfo[] = [];
      for (const tcpPort of securityGroupRuleItem.tcpPorts ?? []) {
        const defaultRuleProps = {
          protocol: cdk.aws_ec2.Protocol.TCP,
          from: tcpPort,
          to: tcpPort,
        };
        securityGroupRules.push(...processSecurityGroupSources(securityGroupRuleItem, defaultRuleProps));
      }
      return securityGroupRules;
    };
    const processUdpSources = (securityGroupRuleItem: SecurityGroupRuleConfig) => {
      const securityGroupRules: SecurityGroupRuleInfo[] = [];
      for (const tcpPort of securityGroupRuleItem.udpPorts ?? []) {
        const defaultRuleProps = {
          protocol: cdk.aws_ec2.Protocol.UDP,
          from: tcpPort,
          to: tcpPort,
        };
        securityGroupRules.push(...processSecurityGroupSources(securityGroupRuleItem, defaultRuleProps));
      }
      return securityGroupRules;
    };
    const processTypeSources = (securityGroupRuleItem: SecurityGroupRuleConfig) => {
      const securityGroupRules: SecurityGroupRuleInfo[] = [];
      for (const ruleType of securityGroupRuleItem.types ?? []) {
        if (ruleType === 'ALL') {
          const defaultRuleProps = {
            protocol: cdk.aws_ec2.Protocol.ALL,
            type: ruleType,
          };
          securityGroupRules.push(...processSecurityGroupSources(securityGroupRuleItem, defaultRuleProps));
        } else {
          const defaultRuleProps = {
            protocol: cdk.aws_ec2.Protocol.TCP,
            type: ruleType,
            from: TCP_PROTOCOLS_PORT[ruleType],
            to: TCP_PROTOCOLS_PORT[ruleType],
          };
          securityGroupRules.push(...processSecurityGroupSources(securityGroupRuleItem, defaultRuleProps));
        }
      }
      return securityGroupRules;
    };
    for (const securityGroupItem of vpcItem.securityGroups ?? []) {
      const existingSecurityGroup = this.findResourceByName(
        vpcStackInfo.resources,
        'GroupName',
        securityGroupItem.name,
      );
      if (!existingSecurityGroup) continue;
      const securityGroup = vpcStack.getResource(existingSecurityGroup.logicalResourceId) as CfnSecurityGroup;
      console.log(
        'Adding SSM Parameter for',
        `${pascalCase(vpcItem.name) + pascalCase(securityGroupItem.name)}SecurityGroup`,
      );
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(securityGroupItem.name)}SecurityGroup`),
        parameterName: this.scope.getSsmPath(SsmResourceType.SECURITY_GROUP, [vpcItem.name, securityGroupItem.name]),
        stringValue: securityGroup.ref,
      });
      this.scope.addAseaResource(AseaResourceType.EC2_SECURITY_GROUP, `${vpcItem.name}/${securityGroupItem.name}`);
      securityGroupsMap.set(securityGroupItem.name, existingSecurityGroup.logicalResourceId);
      securityGroupPhysicalIdMap.set(securityGroupItem.name, existingSecurityGroup.physicalResourceId);
    }

    for (const securityGroupItem of vpcItem.securityGroups ?? []) {
      const logicalId = securityGroupsMap.get(securityGroupItem.name);
      if (!logicalId) continue;
      const securityGroupIngressRules: SecurityGroupRuleInfo[] = [];
      const securityGroupEgressRules: SecurityGroupRuleInfo[] = [];
      const egressRules = this.filterResourcesByRef(
        this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.SECURITY_GROUP_EGRESS),
        'GroupId',
        logicalId,
      );
      const ingressRules = this.filterResourcesByRef(
        this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.SECURITY_GROUP_INGRESS),
        'GroupId',
        logicalId,
      );
      for (const ingressRuleItem of securityGroupItem.inboundRules) {
        securityGroupIngressRules.push(
          ...processTcpSources(ingressRuleItem),
          ...processUdpSources(ingressRuleItem),
          ...processTypeSources(ingressRuleItem),
        );
      }
      for (const egressRuleItem of securityGroupItem.outboundRules) {
        securityGroupEgressRules.push(
          ...processTcpSources(egressRuleItem),
          ...processUdpSources(egressRuleItem),
          ...processTypeSources(egressRuleItem),
        );

        const existingIngressRulesToBeUpdated: CfnSecurityGroup.IngressProperty[] = [];
        securityGroupIngressRules.forEach(configIngressRule => {
          let existingIngressRuleEntry = false;
          for (const existingIngressRule of ingressRules) {
            let ipProtocol = false;
            let fromPort = false;
            let toPort = false;
            let cidrIp = false;
            let sourceSecurityGroupId = false;
            if (
              existingIngressRule.resourceMetadata['Properties'].IpProtocol &&
              existingIngressRule.resourceMetadata['Properties'].IpProtocol === configIngressRule.protocol
            ) {
              ipProtocol = true;
            }
            //IF LZA rule has type of ALL, there won't be to and from port
            if (configIngressRule.type === 'ALL') {
              if (existingIngressRule.resourceMetadata['Properties'].FromPort === configIngressRule.from) {
                fromPort = true;
              }
              if (existingIngressRule.resourceMetadata['Properties'].ToPort === configIngressRule.to) {
                toPort = true;
              }
            } else {
              if (
                existingIngressRule.resourceMetadata['Properties'].FromPort &&
                existingIngressRule.resourceMetadata['Properties'].FromPort === configIngressRule.from
              ) {
                fromPort = true;
              }
              if (
                existingIngressRule.resourceMetadata['Properties'].ToPort &&
                existingIngressRule.resourceMetadata['Properties'].ToPort === configIngressRule.to
              ) {
                toPort = true;
              }
            }
            if (
              existingIngressRule.resourceMetadata['Properties'].CidrIp &&
              existingIngressRule.resourceMetadata['Properties'].CidrIp === configIngressRule.sourceValue
            ) {
              cidrIp = true;
            }
            if (
              existingIngressRule.resourceMetadata['Properties'].SourceSecurityGroupId &&
              existingIngressRule.resourceMetadata['Properties'].SourceSecurityGroupId.Ref ===
                configIngressRule.sourceValue
            ) {
              sourceSecurityGroupId = true;
            }
            if (ipProtocol && fromPort && toPort && (cidrIp || sourceSecurityGroupId)) {
              existingIngressRuleEntry = true;
              break;
            }
          }

          // If Ingress Rule already Exists, add to ASEA resources file and continue
          // The ASEA resource lookup for ingress rules is not currently utilized, and is handled below.
          if (existingIngressRuleEntry) {
            this.scope.addAseaResource(
              AseaResourceType.EC2_SECURITY_GROUP_INGRESS,
              `${vpcItem.name}/${securityGroupItem.name}/ingress/${configIngressRule.source}-${configIngressRule.from}-${configIngressRule.to}-${configIngressRule.protocol}`,
            );
          }
          // Else it is a new rule so needs to be updated on existing sg
          // LogicalId was already set as Security Group Logical Id above
          else {
            //Based off of the source, we need to identify if the source is prefix-list, cidrIpv4 cidrIpv6, or security-group
            //This is an example object where source would come from.
            /*
              {
                protocol: '-1',
                type: 'ALL',
                source: 'Mgmt_sg',
                sourceValue: 'DevSecurityGroupsDevMgmtCCDE5A61'
              }
            */
            // Tried If Ingress Rule doesn't already exist, take LZA attributes and cast them to IngressProperty object, then push. Have to create new object bc IngressProperty type is read only.
            if (configIngressRule.type !== 'ALL') {
              const existingIngressRuleToBeUpdated: CfnSecurityGroup.IngressProperty = {
                ipProtocol: configIngressRule.protocol,
                description: configIngressRule.description,
                fromPort: configIngressRule.from,
                toPort: configIngressRule.to,
              };
              existingIngressRulesToBeUpdated.push(existingIngressRuleToBeUpdated);
            }
            if (configIngressRule.sourceType === 'sg') {
              const existingIngressRuleToBeUpdated: CfnSecurityGroup.IngressProperty = {
                ipProtocol: configIngressRule.protocol,
                description: configIngressRule.description,
                sourceSecurityGroupId: securityGroupPhysicalIdMap.get(configIngressRule.source)!,
              };
              existingIngressRulesToBeUpdated.push(existingIngressRuleToBeUpdated);
            }

            if (configIngressRule.sourceType === 'pl') {
              const existingIngressRuleToBeUpdated: CfnSecurityGroup.IngressProperty = {
                ipProtocol: configIngressRule.protocol,
                description: configIngressRule.description,
                sourcePrefixListId: configIngressRule.source,
              };
              existingIngressRulesToBeUpdated.push(existingIngressRuleToBeUpdated);
            }
            if (configIngressRule.sourceType === 'subnet') {
              const existingIngressRuleToBeUpdated: CfnSecurityGroup.IngressProperty = {
                ipProtocol: configIngressRule.protocol,
                description: configIngressRule.description,
                cidrIp: configIngressRule.sourceValue,
                fromPort: configIngressRule.from,
                toPort: configIngressRule.to,
              };
              existingIngressRulesToBeUpdated.push(existingIngressRuleToBeUpdated);
            }
            const sourceCidrType = this.checkCidrFromSource(configIngressRule.source);

            if (sourceCidrType === 'cidrIpv4') {
              const existingIngressRuleToBeUpdated: CfnSecurityGroup.IngressProperty = {
                ipProtocol: configIngressRule.protocol,
                description: configIngressRule.description,
                cidrIp: configIngressRule.source,
                fromPort: configIngressRule.from,
                toPort: configIngressRule.to,
              };
              existingIngressRulesToBeUpdated.push(existingIngressRuleToBeUpdated);
            }

            if (sourceCidrType === 'cidrIpv6') {
              const existingIngressRuleToBeUpdated: CfnSecurityGroup.IngressProperty = {
                ipProtocol: configIngressRule.protocol,
                description: configIngressRule.description,
                cidrIpv6: configIngressRule.source,
                fromPort: configIngressRule.from,
                toPort: configIngressRule.to,
              };
              existingIngressRulesToBeUpdated.push(existingIngressRuleToBeUpdated);
            }
          }
        });

        if (existingIngressRulesToBeUpdated && existingIngressRulesToBeUpdated.length > 0) {
          const securityGroup = vpcStack.getResource(logicalId) as CfnSecurityGroup;
          console.log('Updating Ingress rules on SG:', securityGroup.groupName);
          console.log('Pushing on rule(s):', existingIngressRulesToBeUpdated);
          if (securityGroup) {
            securityGroup.securityGroupIngress = existingIngressRulesToBeUpdated;
          }
        }

        securityGroupEgressRules.forEach(configEgressRule => {
          const existingEgressRuleEntry = egressRules.find(
            existingEgressRule =>
              ((existingEgressRule.resourceMetadata['Properties'].IpProtocol &&
                existingEgressRule.resourceMetadata['Properties'].IpProtocol === configEgressRule.protocol) ||
                true) &&
              ((existingEgressRule.resourceMetadata['Properties'].FromPort &&
                existingEgressRule.resourceMetadata['Properties'].FromPort === configEgressRule.from) ||
                true) &&
              ((existingEgressRule.resourceMetadata['Properties'].ToPort &&
                existingEgressRule.resourceMetadata['Properties'].ToPort === configEgressRule.to) ||
                true) &&
              ((existingEgressRule.resourceMetadata['Properties'].CidrIp &&
                existingEgressRule.resourceMetadata['Properties'].CidrIp === configEgressRule.sourceValue) ||
                true) &&
              ((existingEgressRule.resourceMetadata['Properties'].SourceSecurityGroupId &&
                existingEgressRule.resourceMetadata['Properties'].SourceSecurityGroupId.Ref ===
                  configEgressRule.sourceValue) ||
                true),
          );
          // Updated to existing egress is not handled here.
          if (existingEgressRuleEntry)
            this.scope.addAseaResource(
              AseaResourceType.EC2_SECURITY_GROUP_EGRESS,
              `${vpcItem.name}/${securityGroupItem.name}/egress/${configEgressRule.source}-${configEgressRule.from}-${configEgressRule.to}-${configEgressRule.protocol}`,
            );
        });
      }
    }
  }

  private checkCidrFromSource(source: string) {
    let sourceType;
    if (this.isValidIpv4Cidr(source)) {
      sourceType = 'cidrIpv4';
    }
    if (this.isValidIpv6Cidr(source)) {
      sourceType = 'cidrIpv6';
    }
    return sourceType;
  }

  private createTransitGatewayAttachments(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    subnetRefs: { [name: string]: CfnSubnet },
  ) {
    const tgwAttachmentMap: { [name: string]: string } = {};
    const tgwAttachmentResources = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.TGW_ATTACHMENT);
    if (tgwAttachmentResources.length === 0) return;
    if (vpcItem.transitGatewayAttachments?.length === 0 && tgwAttachmentResources.length > 0) {
      this.scope.addLogs(LogLevel.WARN, `TGW Attachment is removed from VPC "${vpcItem.name}" configuration`);
      return;
    }
    for (const tgwAttachmentItem of vpcItem.transitGatewayAttachments ?? []) {
      const tgwAttachmentResource = this.findResourceByTag(tgwAttachmentResources, `${tgwAttachmentItem.name}`);
      if (!tgwAttachmentResource) continue;
      const tgwAttachment = vpcStack.getResource(
        tgwAttachmentResource.logicalResourceId,
      ) as CfnTransitGatewayAttachment;
      const subnetIds: string[] = [];
      tgwAttachmentItem.subnets.forEach(subnet => {
        let subnetId = subnetRefs[subnet].ref;
        if (!subnetId) {
          subnetId = this.scope.getExternalResourceParameter(
            this.scope.getSsmPath(SsmResourceType.SUBNET, [vpcItem.name, subnet]),
          );
        }
        if (subnetId) subnetIds.push(subnetId);
      });
      // Only Subnets can be updated in TGW Attachment.
      tgwAttachment.subnetIds = subnetIds;
      this.addSsmParameter({
        logicalId: pascalCase(
          `SsmParam${pascalCase(vpcItem.name) + pascalCase(tgwAttachmentItem.name)}TransitGatewayAttachmentId`,
        ),
        parameterName: this.scope.getSsmPath(SsmResourceType.TGW_ATTACHMENT, [vpcItem.name, tgwAttachmentItem.name]),
        stringValue: tgwAttachment.ref,
      });
      this.scope.addAseaResource(
        AseaResourceType.TRANSIT_GATEWAY_ATTACHMENT,
        `${vpcItem.name}/${tgwAttachmentItem.name}`,
      );
      tgwAttachmentMap[tgwAttachmentItem.name] = tgwAttachmentResource.logicalResourceId;
    }
    return tgwAttachmentMap;
  }

  private getTgwRouteTableId(routeTableName: string) {
    if (!this.props.globalConfig.externalLandingZoneResources?.templateMap) {
      return;
    }
    const tgwStackMapping = this.props.globalConfig.externalLandingZoneResources.templateMap.find(
      stackInfo =>
        stackInfo.phase === 0 &&
        stackInfo.accountKey === this.stackInfo.accountKey &&
        stackInfo.region === this.stackInfo.region,
    );
    const tgwRouteTableResources = this.filterResourcesByType(
      tgwStackMapping?.resources ?? [],
      RESOURCE_TYPE.TRANSIT_GATEWAY_ROUTE_TABLE,
    );
    const tgwRouteTableResource = this.findResourceByTag(tgwRouteTableResources, routeTableName);
    return tgwRouteTableResource?.physicalResourceId;
  }

  private createTransitGatewayRouteTablePropagation(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    tgwAttachMap: { [name: string]: string },
  ) {
    const tgwPropagations = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.TGW_PROPAGATION);
    if (tgwPropagations.length === 0) return;
    const createPropagations = (tgwAttachmentItem: TransitGatewayAttachmentConfig) => {
      for (const routeTableItem of tgwAttachmentItem.routeTablePropagations ?? []) {
        const tgwPropagationRes = tgwPropagations.find(
          propagation =>
            propagation.resourceMetadata['Properties'].TransitGatewayAttachmentId.Ref ===
              tgwAttachMap[tgwAttachmentItem.name] &&
            propagation.resourceMetadata['Properties'].TransitGatewayRouteTableId ===
              this.getTgwRouteTableId(routeTableItem),
        );
        if (!tgwPropagationRes) continue;
        const tgwPropagation = vpcStack.getResource(
          tgwPropagationRes.logicalResourceId,
        ) as cdk.aws_ec2.CfnTransitGatewayRouteTablePropagation;
        if (!tgwPropagation) {
          this.scope.addLogs(
            LogLevel.WARN,
            `TGW Propagation for "${tgwAttachmentItem.name}/${routeTableItem}" exists in Mapping but not found in resources`,
          );
        }
        // Propagation resourceId is not used anywhere in LZA. No need of SSM Parameter.
        this.scope.addAseaResource(
          AseaResourceType.TRANSIT_GATEWAY_PROPAGATION,
          `${tgwAttachmentItem.transitGateway.account}/${tgwAttachmentItem.transitGateway.name}/${tgwAttachmentItem.name}/${routeTableItem}`,
        );
      }
    };
    if (vpcItem.transitGatewayAttachments?.length === 0) {
      this.scope.addLogs(LogLevel.WARN, `TGW Attachment is removed from VPC "${vpcItem.name}" configuration`);
      return;
    }
    (vpcItem.transitGatewayAttachments ?? []).map(createPropagations);
  }

  private createTransitGatewayRouteTableAssociation(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    tgwAttachMap: { [name: string]: string },
  ) {
    const tgwAssociations = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.TGW_ASSOCIATION);
    if (tgwAssociations.length === 0) return;
    const createAssociations = (tgwAttachmentItem: TransitGatewayAttachmentConfig) => {
      for (const routeTableItem of tgwAttachmentItem.routeTableAssociations ?? []) {
        const tgwAssociationRes = tgwAssociations.find(
          propagation =>
            propagation.resourceMetadata['Properties'].TransitGatewayAttachmentId.Ref ===
              tgwAttachMap[tgwAttachmentItem.name] &&
            propagation.resourceMetadata['Properties'].TransitGatewayRouteTableId ===
              this.getTgwRouteTableId(routeTableItem),
        );
        if (!tgwAssociationRes) continue;
        const tgwAssociation = vpcStack.getResource(
          tgwAssociationRes.logicalResourceId,
        ) as cdk.aws_ec2.CfnTransitGatewayRouteTableAssociation;
        if (!tgwAssociation) {
          this.scope.addLogs(
            LogLevel.WARN,
            `TGW Association for "${tgwAttachmentItem.name}/${routeTableItem}" exists in Mapping but not found in resources`,
          );
        }
        // Propagation resourceId is not used anywhere in LZA. No need of SSM Parameter.
        this.scope.addAseaResource(
          AseaResourceType.TRANSIT_GATEWAY_ASSOCIATION,
          `${tgwAttachmentItem.transitGateway.account}/${tgwAttachmentItem.transitGateway.name}/${tgwAttachmentItem.name}/${routeTableItem}`,
        );
      }
    };
    if (vpcItem.transitGatewayAttachments?.length === 0) {
      this.scope.addLogs(LogLevel.WARN, `TGW Attachment is removed from VPC "${vpcItem.name}" configuration`);
      return;
    }
    (vpcItem.transitGatewayAttachments ?? []).map(createAssociations);
  }

  createRouteTables(vpcItem: VpcConfig | VpcTemplatesConfig, vpcStackInfo: NestedAseaStackInfo, vpcStack: CfnInclude) {
    const existingRouteTablesMapping = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.ROUTE_TABLE);
    for (const routeTableItem of vpcItem.routeTables ?? []) {
      const routeTableResource = this.findResourceByTag(existingRouteTablesMapping, routeTableItem.name);
      if (!routeTableResource) continue;
      const routeTable = vpcStack.getResource(routeTableResource.logicalResourceId) as CfnRouteTable;
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcItem.name)}${pascalCase(routeTableItem.name)}RouteTableId`),
        parameterName: this.scope.getSsmPath(SsmResourceType.ROUTE_TABLE, [vpcItem.name, routeTableItem.name]),
        stringValue: routeTable.ref,
      });
      this.scope.addAseaResource(AseaResourceType.ROUTE_TABLE, `${vpcItem.name}/${routeTableItem.name}`);
    }
  }

  /**
   * Find VPC Resource by tag and nestedStackInfo of VPC
   * @param vpcName
   * @returns
   */
  private getVpcResourceByTag(vpcName: string) {
    for (const nestedStackInfo of this.nestedStacksInfo) {
      const vpcResources = nestedStackInfo.resources.filter(
        cfnResource => cfnResource.resourceType === RESOURCE_TYPE.VPC,
      );
      const vpcResource = vpcResources.find(cfnResource =>
        cfnResource.resourceMetadata['Properties'].Tags.find(
          (tag: { Key: string; Value: string }) => tag.Key === 'Name' && tag.Value === vpcName,
        ),
      );
      if (vpcResource) {
        return {
          stackInfo: nestedStackInfo,
          resource: vpcResource,
        };
      }
    }
    return;
  }

  /**
   * Find Subnet Resource by tag and nestedStackInfo of VPC
   * @param vpcName
   * @returns
   */
  private getSubnetResourceByTag(subnetName: string, nestedStackInfo: NestedAseaStackInfo) {
    const subnetResources = nestedStackInfo.resources.filter(
      cfnResource => cfnResource.resourceType === RESOURCE_TYPE.SUBNET,
    );
    const subnetResource = this.findResourceByTag(subnetResources, subnetName);
    if (subnetResource) {
      return subnetResource;
    }
    return;
  }

  private getAdditionalCidrs(stackInfo: NestedAseaStackInfo) {
    return stackInfo.resources.filter(cfnResource => cfnResource.resourceType === RESOURCE_TYPE.CIDR_BLOCK);
  }

  private createNetworkFirewallRuleGroups(vpcStackInfo: NestedAseaStackInfo, vpcStack: CfnInclude) {
    const ruleGroupMap = new Map<string, string>();
    const networkFirewallConfig = this.props.networkConfig.centralNetworkServices?.networkFirewall;
    const firewallRuleGroupResources = this.filterResourcesByType(
      vpcStackInfo.resources,
      RESOURCE_TYPE.NETWORK_FIREWALL_RULE_GROUP,
    );
    if (firewallRuleGroupResources.length === 0) {
      return;
    }
    for (const firewallRuleGroupResource of firewallRuleGroupResources) {
      const aseaManagedRuleGroupName: string = firewallRuleGroupResource.resourceMetadata['Properties'].RuleGroupName;
      const ruleItem = networkFirewallConfig?.rules.find(group => group.name === aseaManagedRuleGroupName);
      if (!ruleItem) {
        this.scope.addLogs(
          LogLevel.WARN,
          `No Firewall Rule Group found in configuration and firewall policy present in resource mapping`,
        );
        continue;
      }
      const rule = NetworkFirewallRuleGroup.includedCfnResource(
        vpcStack,
        firewallRuleGroupResource.logicalResourceId,
        ruleItem,
      );
      ruleGroupMap.set(ruleItem.name, rule.ref);
      this.addSsmParameter({
        logicalId: pascalCase(`SsmParam${ruleItem.name}NetworkFirewallRuleGroup`),
        parameterName: this.scope.getSsmPath(SsmResourceType.NFW_RULE_GROUP, [ruleItem.name]),
        stringValue: rule.ref,
      });
      this.scope.addAseaResource(AseaResourceType.NFW_RULE_GROUP, ruleItem.name);
    }
    return ruleGroupMap;
  }

  private getRuleGroupReferences<T>(
    ruleGroupReferences: NfwStatefulRuleGroupReferenceConfig[],
    ruleGroupMap?: Map<string, string>,
  ): T[] {
    const references: T[] = [];

    for (const reference of ruleGroupReferences) {
      let groupArn = !!ruleGroupMap && ruleGroupMap.get(reference.name);
      if (!groupArn) {
        groupArn = this.scope.getSsmPath(SsmResourceType.NFW_RULE_GROUP, [reference.name]);
      }
      if (groupArn) references.push({ resourceArn: groupArn, priority: reference.priority } as T);
    }
    return references;
  }

  private createNetworkFirewallPolicy(
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    ruleGroupsMap?: Map<string, string>,
  ) {
    const networkFirewallConfig = this.props.networkConfig.centralNetworkServices?.networkFirewall;
    const firewallResources = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.NETWORK_FIREWALL_POLICY);
    if (firewallResources.length === 0) {
      return;
    }
    const aseaManagedPolicy = firewallResources[0];
    const aseaManagedPolicyName: string = aseaManagedPolicy.resourceMetadata['Properties'].FirewallPolicyName;
    const policyItem = networkFirewallConfig?.policies.find(policy => policy.name === aseaManagedPolicyName);
    if (!policyItem) {
      this.scope.addLogs(
        LogLevel.WARN,
        `No Firewall Policy found in configuration and firewall policy present in resource mapping`,
      );
      return;
    }
    const firewallPolicy: FirewallPolicyProperty = {
      statelessDefaultActions: policyItem.firewallPolicy.statelessDefaultActions,
      statelessFragmentDefaultActions: policyItem.firewallPolicy.statelessFragmentDefaultActions,
      statefulDefaultActions: policyItem.firewallPolicy.statefulDefaultActions,
      statefulEngineOptions: policyItem.firewallPolicy.statefulEngineOptions,
      statefulRuleGroupReferences: policyItem.firewallPolicy.statefulRuleGroups
        ? this.getRuleGroupReferences<{ resourceArn: string; priority?: number }>(
            policyItem.firewallPolicy.statefulRuleGroups,
            ruleGroupsMap,
          )
        : [],
      statelessCustomActions: policyItem.firewallPolicy.statelessCustomActions,
      statelessRuleGroupReferences: policyItem.firewallPolicy.statelessRuleGroups
        ? this.getRuleGroupReferences<{ resourceArn: string; priority: number }>(
            policyItem.firewallPolicy.statelessRuleGroups,
            ruleGroupsMap,
          )
        : [],
    };
    const policy = NetworkFirewallPolicy.includedCfnResource(vpcStack, aseaManagedPolicy.logicalResourceId, {
      description: policyItem.description,
      name: policyItem.name,
      firewallPolicy,
    });
    this.addSsmParameter({
      logicalId: pascalCase(`SsmParam${policyItem.name}NetworkFirewallPolicy`),
      parameterName: this.scope.getSsmPath(SsmResourceType.NFW_POLICY, [policyItem.name]),
      stringValue: policy.ref,
    });
    this.scope.addAseaResource(AseaResourceType.NFW_POLICY, policyItem.name);
    return {
      name: policyItem.name,
      arn: policy.ref,
    };
  }

  private addFirewallLoggingConfiguration(
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    firewallItem: NfwFirewallConfig,
  ) {
    const loggingConfigurationResource = this.filterResourcesByType(
      vpcStackInfo.resources,
      RESOURCE_TYPE.NETWORK_FIREWALL_LOGGING,
    );
    if (!loggingConfigurationResource) return;
    const loggingConfiguration = vpcStack.getResource(
      loggingConfigurationResource[0].logicalResourceId,
    ) as cdk.aws_networkfirewall.CfnLoggingConfiguration;
    const destinationConfigs: cdk.aws_networkfirewall.CfnLoggingConfiguration.LogDestinationConfigProperty[] = [];
    for (const logItem of firewallItem.loggingConfiguration ?? []) {
      if (logItem.destination === 'cloud-watch-logs') {
        // Create log group and log configuration
        const logGroup = new cdk.aws_logs.LogGroup(
          vpcStack,
          pascalCase(`${firewallItem.name}${logItem.type}LogGroup`),
          {
            encryptionKey: this.scope.cloudwatchKey,
            retention: this.props.globalConfig.cloudwatchLogRetentionInDays,
          },
        );
        destinationConfigs.push({
          logDestination: {
            logGroup: logGroup.logGroupName,
          },
          logDestinationType: 'CloudWatchLogs',
          logType: logItem.type,
        });
      }

      if (logItem.destination === 's3') {
        destinationConfigs.push({
          logDestination: {
            bucketName: this.scope.firewallBucket.bucketName,
            prefix: 'firewall',
          },
          logDestinationType: 'S3',
          logType: logItem.type,
        });
      }
    }
    loggingConfiguration.loggingConfiguration = {
      logDestinationConfigs: destinationConfigs,
    };
  }
  private createNetworkFirewall(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    vpcId: string,
    subnets: { [name: string]: CfnSubnet },
    policy?: {
      name: string;
      arn: string;
    },
  ) {
    const networkFirewallConfig = this.props.networkConfig.centralNetworkServices?.networkFirewall;
    const firewallsConfig = networkFirewallConfig?.firewalls.filter(
      firewallConfig => firewallConfig && firewallConfig.vpc === vpcItem.name,
    );
    const firewallResources = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.NETWORK_FIREWALL);
    if (firewallResources.length === 0) {
      return;
    } else if (!firewallsConfig || firewallsConfig.length === 0) {
      this.scope.addLogs(LogLevel.WARN, `No Firewall found in configuration and firewall present in resource mapping`);
      return;
    }
    for (const firewallItem of firewallsConfig) {
      const firewallResource = this.findResourceByName(firewallResources, 'FirewallName', firewallItem.name);
      if (!firewallResource) continue;
      const subnetIds: string[] = [];
      firewallItem.subnets.forEach(subnet => {
        let subnetId = subnets[subnet].ref;
        if (!subnetId) {
          subnetId = this.scope.getExternalResourceParameter(
            this.scope.getSsmPath(SsmResourceType.SUBNET, [vpcItem.name, subnet]),
          );
        }
        if (subnetId) subnetIds.push(subnetId);
      });
      let policyArn = !!policy && firewallItem.firewallPolicy === policy?.name ? policy.arn : undefined;
      if (!policyArn) {
        policyArn = this.scope.getExternalResourceParameter(
          this.scope.getSsmPath(SsmResourceType.NFW_POLICY, [firewallItem.firewallPolicy]),
        );
      }
      if (!policyArn) {
        throw new Error(
          `Firewall is managed externally and no SSM Parameter found for policy "${firewallItem.firewallPolicy}"`,
        );
      }
      const firewall = NetworkFirewall.includedCfnResource(vpcStack, firewallResource.logicalResourceId, {
        firewallPolicyArn: policyArn,
        name: firewallItem.name,
        description: firewallItem.description,
        subnets: subnetIds,
        vpcId: vpcId,
        deleteProtection: firewallItem.deleteProtection,
        firewallPolicyChangeProtection: firewallItem.firewallPolicyChangeProtection,
        subnetChangeProtection: firewallItem.subnetChangeProtection,
      });
      this.addFirewallLoggingConfiguration(vpcStackInfo, vpcStack, firewallItem);
      this.ssmParameters.push({
        logicalId: pascalCase(`SsmParam${pascalCase(firewallItem.vpc) + pascalCase(firewallItem.name)}FirewallArn`),
        parameterName: this.scope.getSsmPath(SsmResourceType.NFW, [firewallItem.vpc, firewallItem.name]),
        stringValue: firewall.attrFirewallArn,
      });
      this.scope.addAseaResource(AseaResourceType.NFW, firewallItem.name);
    }
  }

  /**
   * Returns true if the given CIDR is valid
   * @param cidr
   * @returns
   */
  private isValidIpv4Cidr(cidr: string): boolean {
    try {
      IPv4CidrRange.fromCidr(cidr);
    } catch (e) {
      return false;
    }
    return true;
  }

  /**
   * Returns true if valid CIDR is valid
   * @param cidr
   * @returns
   */
  private isValidIpv6Cidr(cidr: string): boolean {
    try {
      IPv6CidrRange.fromCidr(cidr);
    } catch (e) {
      return false;
    }
    return true;
  }

  private createNetworkFirewallResources(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
    vpcId: string,
    subnets: { [name: string]: CfnSubnet },
  ) {
    const ruleGroupsMap = this.createNetworkFirewallRuleGroups(vpcStackInfo, vpcStack);
    const firewallPolicy = this.createNetworkFirewallPolicy(vpcStackInfo, vpcStack, ruleGroupsMap);
    this.createNetworkFirewall(vpcItem, vpcStackInfo, vpcStack, vpcId, subnets, firewallPolicy);
  }

  private gatewayEndpoints(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcStackInfo: NestedAseaStackInfo,
    vpcStack: CfnInclude,
  ) {
    /**
     * Function to get S3 and DynamoDB route table ids
     * @param routeTableItem {@link RouteTableConfig}
     * @param routeTableId string
     */
    const getS3DynamoDbRouteTableIds = (
      routeTableItem: RouteTableConfig,
      routeTableId: string,
      s3EndpointRouteTables: string[],
      dynamodbEndpointRouteTables: string[],
    ) => {
      for (const routeTableEntryItem of routeTableItem.routes ?? []) {
        // Route: S3 Gateway Endpoint
        if (routeTableEntryItem.target === 's3') {
          if (!s3EndpointRouteTables.find(item => item === routeTableId)) {
            s3EndpointRouteTables.push(routeTableId);
          }
        }

        // Route: DynamoDb Gateway Endpoint
        if (routeTableEntryItem.target === 'dynamodb') {
          if (!dynamodbEndpointRouteTables.find(item => item === routeTableId)) {
            dynamodbEndpointRouteTables.push(routeTableId);
          }
        }
      }
    };
    const s3EndpointRouteTables: string[] = [];
    const dynamodbEndpointRouteTables: string[] = [];
    for (const routeTableItem of vpcItem.routeTables ?? []) {
      const routeTableId = this.scope.getExternalResourceParameter(
        this.scope.getSsmPath(SsmResourceType.ROUTE_TABLE, [vpcItem.name, routeTableItem.name]),
      );
      if (!routeTableId) continue; // Route table is not created yet
      getS3DynamoDbRouteTableIds(routeTableItem, routeTableId, s3EndpointRouteTables, dynamodbEndpointRouteTables);
    }
    // ASEA Only creates VPC Endpoints in VPC Nested Stack
    const gatewayEndpointResources = this.filterResourcesByType(vpcStackInfo.resources, RESOURCE_TYPE.VPC_ENDPOINT);
    if (gatewayEndpointResources.length === 0) {
      return;
    } else if (!vpcItem.gatewayEndpoints?.endpoints) {
      this.scope.addLogs(LogLevel.WARN, `Endpoints are removed from configuration`);
      return;
    }

    for (const endpointItem of vpcItem.gatewayEndpoints.endpoints ?? []) {
      const gatewayEndpointResource = gatewayEndpointResources.find(
        cfnResource =>
          cfnResource.resourceMetadata['Properties'].ServiceName['Fn::Join'][1].at(-1) === `.${endpointItem.service}`,
      );
      if (!gatewayEndpointResource) {
        continue;
      }
      const endpoint = vpcStack.getResource(gatewayEndpointResource.logicalResourceId) as cdk.aws_ec2.CfnVPCEndpoint;
      const routeTableIds = endpoint.routeTableIds;
      if (!routeTableIds) {
        endpoint.routeTableIds = endpointItem.service === 's3' ? s3EndpointRouteTables : dynamodbEndpointRouteTables;
      } else {
        (endpointItem.service === 's3' ? s3EndpointRouteTables : dynamodbEndpointRouteTables).forEach(routeTableId => {
          if (!routeTableIds.includes(routeTableId)) {
            routeTableIds.push(routeTableId);
          }
        });
      }
      endpoint.routeTableIds = routeTableIds;
      this.ssmParameters.push({
        logicalId: pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(endpointItem.service)}EndpointId`),
        parameterName: this.scope.getSsmPath(SsmResourceType.VPC_ENDPOINT, [vpcItem.name, endpointItem.service]),
        stringValue: endpoint.ref,
      });
      this.scope.addAseaResource(AseaResourceType.VPC_ENDPOINT, `${vpcItem.name}/${endpointItem.service}`);
    }
  }
}
