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

import { IModuleCommonParameter } from '../common/resources';

/**
 * Amazon Security Lake SetDelegatedAdmin configuration
 *
 * @description
 * This is the essential configuration for Amazon Security Lake set delegated admin operation.
 *
 * @example
 *
 * ```
 * {
 *   delegatedAdminAccount: '123456789012'
 * }
 * ```
 */
export interface ISetOrganizationAdminConfiguration {
  delegatedAdminAccount: string;
}

/**
 * Enum for Amazon Security Lake module operations
 */
export enum SecurityLakeModuleOperation {
  /**
   * Sets the organization delegated admin for Amazon Security Lake
   *
   * @remarks
   * If a different delegated admin account was previously registered,
   * it will be de-registered, and the newly configured account will be registered as the delegated admin.
   */
  SET_ORGANIZATION_ADMIN = 'set-organization-admin',

  /**
   * Deregister the current organization delegated admin for Amazon Security Lake
   *
   * @remarks
   * Deregister the delegated admin will delete all data lakes created in that account.
   */
  DEREGISTER_ORGANIZATION_ADMIN = 'deregister-organization-admin',
}

/**
 * Amazon Security Lake module handler parameter
 */
export interface ISecurityLakeHandlerParameter extends IModuleCommonParameter {
  /**
   * Amazon Security Lake configuration
   *
   * @example
   *
   * ```
   * {
   *   delegatedAdminAccount: '123456789012'
   * }
   * ```
   */
  configuration: ISetOrganizationAdminConfiguration | undefined;
}

/**
 * Accelerator Security Lake Module actions interface
 */
export interface ISecurityLakeModuleAction {
  /**
   * Handler function to execute Security Lake Module Actions
   *
   * @param props {@link ISecurityLakeHandlerParameter}
   * @returns status string
   *
   */
  handler(props: ISecurityLakeHandlerParameter): Promise<string>;
}
