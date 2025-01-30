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

import { describe, beforeEach, expect, test, jest } from '@jest/globals';

import { DeregisterOrganizationAdmin } from '../../../lib/security-lake/deregister-organization-admin/index';
import { ISecurityLakeHandlerParameter, SecurityLakeModuleOperation } from '../../../interfaces/security-lake';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { SecurityLakeClient } from '@aws-sdk/client-securitylake';
import { throttlingBackOff } from '../../../common/throttle';
import { getOrganizationDelegatedAdminAccountId } from '../../../common/resources';

jest.mock('../../../common/throttle');
jest.mock('../../../common/resources');
jest.mock('@aws-sdk/client-organizations');
jest.mock('@aws-sdk/client-securitylake');

describe('SecurityLakeDeregisterOrganizationAdmin', () => {
  let deregisterAdmin: DeregisterOrganizationAdmin;
  let mockSecurityLakeClientSend: jest.Mock;

  const baseProp: ISecurityLakeHandlerParameter = {
    operation: SecurityLakeModuleOperation.SET_ORGANIZATION_ADMIN,
    partition: 'aws',
    homeRegion: 'us-east-1',
    credentials: undefined,
    configuration: undefined,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    deregisterAdmin = new DeregisterOrganizationAdmin();
    mockSecurityLakeClientSend = jest.fn();
    (OrganizationsClient as jest.Mock).mockImplementation(() => ({}));
    (SecurityLakeClient as jest.Mock).mockImplementation(() => ({
      send: mockSecurityLakeClientSend,
    }));
    (throttlingBackOff as jest.Mock<typeof throttlingBackOff>).mockImplementation(fn => fn());
  });

  describe('Non-Dry Run Mode', () => {
    test('should deregister admin when admin exists', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce('111122223333');

      const result = await deregisterAdmin.handler(baseProp);

      expect(result).toBe(
        'Amazon Security Lake de-register Organization admin operation completed successfully.\nStatus: Amazon Security Lake Delegated admin account de-registered.',
      );
      expect(mockSecurityLakeClientSend).toHaveBeenCalled();
    });

    test('should skip deregistration when no admin exists', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce(undefined);

      const result = await deregisterAdmin.handler(baseProp);

      expect(result).toBe(
        'Amazon Security Lake de-register Organization admin operation completed successfully.\nStatus: Operation found Amazon Security Lake delegated administrator not set, de-registration skipped.',
      );
      expect(mockSecurityLakeClientSend).not.toHaveBeenCalled();
    });
  });

  describe('Dry Run Mode', () => {
    const dryRunProps = { ...baseProp, dryRun: true };

    test('should validate deregistration when admin exists', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce('111122223333');

      const result = await deregisterAdmin.handler(dryRunProps);

      expect(result).toBe(
        '[DRY-RUN]: Amazon Security Lake de-register organization admin operation validated successfully (no actual changes were made).\nValidation: ✓ Successful\nStatus: Amazon Security Lake Delegated admin account will be de-registered.',
      );
      expect(mockSecurityLakeClientSend).not.toHaveBeenCalled();
    });

    test('should validate skip when no admin exists', async () => {
      (getOrganizationDelegatedAdminAccountId as jest.Mock).mockReturnValueOnce(undefined);

      const result = await deregisterAdmin.handler(dryRunProps);

      expect(result).toBe(
        '[DRY-RUN]: Amazon Security Lake de-register organization admin operation validated successfully (no actual changes were made).\nValidation: ✓ Successful\nStatus: Operation found Amazon Security Lake delegated administrator not set, de-registration will be skipped.',
      );
      expect(mockSecurityLakeClientSend).not.toHaveBeenCalled();
    });
  });
});
