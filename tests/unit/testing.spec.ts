import { describe, expect, it, vi } from 'vitest'

import { mockActivities } from '../../src/testing'

describe('mockActivities', () => {
    class SampleActivity1 {
        prop = 12
        async method1(param1: string): Promise<string> {
            return `real-${param1}`
        }

        async method2(num: number): Promise<number> {
            return num * 2
        }
    }

    class SampleActivity2 {
        async otherMethod(param1: boolean): Promise<string> {
            return `real-${param1}`
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const activities = {
        sample1: SampleActivity1,
        sample: SampleActivity2,
    }

    it('should return empty object when no activities provided', () => {
        // Arrange
        const emptyActivities = {}

        // Act
        const result = mockActivities(emptyActivities)

        // Assert
        expect(result).toEqual({})
    })

    it('should create mocked activity with single method', () => {
        // Arrange
        const mockMethod = vi.fn().mockReturnValue('mocked-value')
        const mockedActivities = {
            sample1: {
                method1: mockMethod,
            },
        }

        // Act
        const result = mockActivities<typeof activities>(mockedActivities)
        const returnValue = result['sample1.method1']('test')

        // Assert
        expect(result).toHaveProperty('sample1.method1')
        expect(result['sample1.method1']).toBe(mockMethod)
        expect(mockMethod).toHaveBeenCalledWith('test')
        expect(returnValue).toBe('mocked-value')
    })

    it('should create mocked activities with multiple methods', () => {
        // Arrange
        const mockMethod1 = vi.fn().mockReturnValue('result1')
        const mockMethod2 = vi.fn().mockReturnValue(42)
        const mockedActivities = {
            sample1: {
                method1: mockMethod1,
                method2: mockMethod2,
            },
        }

        // Act
        const result = mockActivities<typeof activities>(mockedActivities)

        // Assert
        expect(result).toHaveProperty('sample1.method1')
        expect(result).toHaveProperty('sample1.method2')
        expect(result['sample1.method1']).toBe(mockMethod1)
        expect(result['sample1.method2']).toBe(mockMethod2)
    })

    it('should create mocked activities from multiple activity classes', () => {
        // Arrange
        const mockMethod1 = vi.fn().mockReturnValue('result1')
        const mockOtherMethod = vi.fn().mockReturnValue('result2')
        const mockedActivities = {
            sample1: {
                method1: mockMethod1,
            },
            sample: {
                otherMethod: mockOtherMethod,
            },
        }

        // Act
        const result = mockActivities<typeof activities>(mockedActivities)

        result['sample1.method1']('param')
        result['sample.otherMethod'](true)

        // Assert
        expect(result).toHaveProperty('sample1.method1')
        expect(result).toHaveProperty('sample.otherMethod')
        expect(mockMethod1).toHaveBeenCalledWith('param')
        expect(mockOtherMethod).toHaveBeenCalledWith(true)
    })

    it('should skip non-function values', () => {
        // Arrange
        const mockMethod = vi.fn()
        const mockedActivities = {
            sample1: {
                prop: 12 as unknown as never,
                method2: mockMethod,
            },
        }

        // Act
        const result = mockActivities<typeof activities>(mockedActivities)

        // Assert
        expect(result).not.toHaveProperty('sample1.prop')
        expect(result).toHaveProperty('sample1.method2')
    })

    it('should handle undefined activity methods object', () => {
        // Arrange
        const mockedActivities = {
            sample1: undefined,
        }

        // Act
        const result = mockActivities<typeof activities>(mockedActivities)

        // Assert
        expect(result).toEqual({})
    })
})
