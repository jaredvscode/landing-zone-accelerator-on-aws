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
import { OrganizationsClient, ListDelegatedAdministratorsCommand } from '@aws-sdk/client-organizations';
import { getOrganizationDelegatedAdminAccountId } from '../../common/resources';
import { throttlingBackOff } from '../../common/throttle';

jest.mock('@aws-sdk/client-organizations');
jest.mock('../../common/throttle');

describe('getOrganizationDelegatedAdminAccountId', () => {
  let mockOrganizationClientSend: jest.Mock;
  const servicePrincipal = 'securitylake.amazonaws.com';

  beforeEach(() => {
    jest.clearAllMocks();
    (throttlingBackOff as jest.Mock<typeof throttlingBackOff>).mockImplementation(fn => fn());
    mockOrganizationClientSend = jest.fn();
    (OrganizationsClient as jest.Mock).mockImplementation(() => ({
      send: mockOrganizationClientSend,
    }));
  });

  describe('getRegisteredSecurityLakeAdmin', () => {
    test('should return undefined when no admin is registered', async () => {
      mockOrganizationClientSend.mockImplementation(() =>
        Promise.resolve({
          DelegatedAdministrators: [],
        }),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOrganizationDelegatedAdminAccountId(new OrganizationsClient({}), servicePrincipal);

      expect(result).toBeUndefined();
      expect(ListDelegatedAdministratorsCommand).toHaveBeenCalledWith({
        ServicePrincipal: 'securitylake.amazonaws.com',
      });
    });

    test('should return admin ID when one admin is registered', async () => {
      mockOrganizationClientSend.mockImplementation(() =>
        Promise.resolve({
          DelegatedAdministrators: [{ Id: '111122223333' }],
        }),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOrganizationDelegatedAdminAccountId(new OrganizationsClient({}), servicePrincipal);

      expect(result).toBe('111122223333');
    });

    test('should throw error when multiple admins are found', async () => {
      mockOrganizationClientSend.mockImplementation(() =>
        Promise.resolve({
          DelegatedAdministrators: [{ Id: '111122223333' }, { Id: '888888888888' }],
        }),
      );

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getOrganizationDelegatedAdminAccountId(new OrganizationsClient({}), servicePrincipal),
      ).rejects.toThrow(
        'Internal Error: Only 1 delegation admin should be set for securitylake.amazonaws.com, 2 received from the API.',
      );
    });

    test('should handle null/undefined IDs in response', async () => {
      mockOrganizationClientSend.mockImplementation(() =>
        Promise.resolve({
          DelegatedAdministrators: [{ Id: null }, { Id: undefined }],
        }),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOrganizationDelegatedAdminAccountId(new OrganizationsClient({}), servicePrincipal);

      expect(result).toBeUndefined();
    });

    test('should handle null in response', async () => {
      mockOrganizationClientSend.mockImplementation(() =>
        Promise.resolve({
          DelegatedAdministrators: null,
        }),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOrganizationDelegatedAdminAccountId(new OrganizationsClient({}), servicePrincipal);

      expect(result).toBeUndefined();
    });
  });
});
