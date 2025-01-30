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

import { registerDelegatedAdmin } from '../../executors/accelerator-security-lake';
import { RegisterOrganizationAdmin } from '../../lib/security-lake/register-organization-admin/index';

jest.mock('../../lib/security-lake/register-organization-admin/index');

const MOCK_CONSTANTS = {
  input: {
    operation: 'set-organization-admin',
    partition: 'aws',
    homeRegion: 'us-east-1',
    configuration: {
      delegatedAdminAccount: '111122223333',
    },
  },
};

describe('setupSecurityLake', () => {
  const mockRegisterHandler = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (RegisterOrganizationAdmin as jest.Mock).mockImplementation(() => ({
      handler: mockRegisterHandler,
    }));
  });

  test('should successfully setup Security Lake', async () => {
    mockRegisterHandler.mockResolvedValue('SUCCESS' as never);

    const result = await registerDelegatedAdmin(MOCK_CONSTANTS.input);

    expect(result).toBe('SUCCESS');
    expect(mockRegisterHandler).toHaveBeenCalledWith(MOCK_CONSTANTS.input);
    expect(mockRegisterHandler).toHaveBeenCalledTimes(1);
  });

  test('should throw error when setup fails', async () => {
    const errorMessage = 'Setup failed';
    mockRegisterHandler.mockRejectedValue(new Error(errorMessage) as never);

    await expect(registerDelegatedAdmin(MOCK_CONSTANTS.input)).rejects.toThrow(errorMessage);
  });

  describe('Uncaught Exception Handler', () => {
    let originalProcessOn: typeof process.on;
    let processOnCallback: NodeJS.UncaughtExceptionListener;

    beforeEach(() => {
      originalProcessOn = process.on;

      process.on = jest.fn((event: string, listener: NodeJS.UncaughtExceptionListener) => {
        if (event === 'uncaughtException') {
          processOnCallback = listener;
        }
        return process;
      }) as unknown as typeof process.on;

      jest.resetModules();
    });

    afterEach(() => {
      process.on = originalProcessOn;
    });

    test('should register uncaughtException handler', () => {
      require('../../executors/accelerator-security-lake');

      expect(process.on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    });

    test('should rethrow the error when uncaughtException occurs', () => {
      require('../../executors/accelerator-security-lake');

      const testError = new Error('Test uncaught exception');
      const origin = 'uncaughtException';

      expect(processOnCallback).toBeDefined();

      expect(() => {
        processOnCallback(testError, origin);
      }).toThrow(testError);
    });
  });
});
