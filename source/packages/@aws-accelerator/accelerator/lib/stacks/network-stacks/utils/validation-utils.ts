/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { VpnConnectionConfig } from '@aws-accelerator/config';
import { IPv4, IPv4CidrRange } from 'ip-num';
import { getObjectKeys } from './getter-utils';

/**
 * Determines if a VPN connection has advanced options.
 * Advanced options are options that are not supported by the native VPN provider.
 * @param vpn VpnConnectionConfig
 * @returns boolean
 */
export function hasAdvancedVpnOptions(vpn: VpnConnectionConfig): boolean {
  //
  // Get configured options keys
  const inputVpnKeys = getObjectKeys(vpn);
  const inputVpnOptionsKeys = vpn.tunnelSpecifications
    ? [...new Set([...getObjectKeys(vpn.tunnelSpecifications[0]), ...getObjectKeys(vpn.tunnelSpecifications[1])])]
    : [];
  //
  // Set native resource keys
  const nativeVpnKeys = [
    'name',
    'transitGateway',
    'vpc',
    'routeTableAssociations',
    'routeTablePropagations',
    'staticRoutesOnly',
    'tunnelSpecifications',
    'tags',
  ];
  const nativeVpnOptionsKeys = ['preSharedKey', 'tunnelInsideCidr'];
  //
  // Compare input keys against native resource keys
  if (inputVpnKeys.some(key => !nativeVpnKeys.includes(key))) {
    return true;
  }
  if (inputVpnOptionsKeys.some(optionKey => !nativeVpnOptionsKeys.includes(optionKey))) {
    return true;
  }
  return false;
}

/**
 * Returns true if the passed string is a valid IPv4 CIDR.
 *
 * @param cidr string
 * @returns boolean
 */
export function isIpv4Cidr(cidr: string): boolean {
  try {
    IPv4CidrRange.fromCidr(cidr);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Returns true if the passed string is a valid IPv4 address.
 *
 * @param ip string
 * @returns boolean
 */
export function isIpv4(ip: string): boolean {
  try {
    IPv4.fromString(ip);
    return true;
  } catch (e) {
    return false;
  }
}
