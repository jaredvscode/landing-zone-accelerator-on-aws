/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
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

import { ISecurityLakeHandlerParameter } from '../interfaces/security-lake';
import { RegisterOrganizationAdmin } from '../lib/security-lake/register-organization-admin';

process.on('uncaughtException', err => {
  throw err;
});

/**
 * Function to setup Amazon Security Lake.
 * @param input {@link ISecurityLakeHandlerParameter}
 *
 * @description
 * Use this function to configure Amazon Security Lake in your AWS Organizations.
 * This function can create or update the Amazon Security Lake.
 *
 * When a Amazon Security Lake delegated admin is already set, it will change it to the configured account.
 *
 * @example
 * ```
 * const param: ISecurityLakeHandlerParameter = {
 *   partition: 'aws',
 *   homeRegion: 'us-east-1',
 *   operation: 'set-organization-admin',
 *   configuration: {
 *     delegatedAdminAccount: '111122223333'
 *   }
 * }
 *
 * const status = await registerDelegatedAdmin(param);
 * ```
 *
 * @returns status string
 */
export async function registerDelegatedAdmin(input: ISecurityLakeHandlerParameter): Promise<string> {
  try {
    return await new RegisterOrganizationAdmin().handler(input);
  } catch (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    e: any
  ) {
    console.error(e.message);
    throw new Error(`${e}`);
  }
}
