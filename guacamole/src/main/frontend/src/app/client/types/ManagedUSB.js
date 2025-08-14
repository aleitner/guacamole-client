/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Provides the ManagedUSB class used by ManagedClient to represent
 * USB devices connected via WebUSB and tunneled to the remote desktop.
 * Enhanced with comprehensive USB descriptor support and flattened protocol.
 */
angular.module('client').factory('ManagedUSB', ['$injector', 
    function defineManagedUSB($injector) {

    // Required services
    const $q = $injector.get('$q');

    /**
     * Object which represents a USB device connected via WebUSB and tunneled
     * to a remote desktop connection.
     * 
     * @constructor
     * @param {ManagedUSB|Object} [template={}]
     *     The object whose properties should be copied within the new
     *     ManagedUSB.
     */
    const ManagedUSB = function ManagedUSB(template) {
        // Use empty object by default
        template = template || {};

        this.client = template.client;
        this.device = template.device;
        
        // Device information
        this.name = template.name || (this.device ? (this.device.productName || 'USB Device') : null);
        this.id = template.id || (this.device ? this.device.serialNumber : null);
        this.vendorId = template.vendorId || (this.device ? this.device.vendorId : null);
        this.productId = template.productId || (this.device ? this.device.productId : null);
        this.serialNumber = template.serialNumber || (this.device ? (this.device.serialNumber || '') : '');
        this.deviceClass = template.deviceClass || (this.device ? this.device.deviceClass : 0);
        this.deviceSubclass = template.deviceSubclass || (this.device ? this.device.deviceSubclass : 0);
        this.deviceProtocol = template.deviceProtocol || (this.device ? this.device.deviceProtocol : 0);
        
        // Connection state tracking
        this.connected = template.connected || false;
        this.claimed = template.claimed || false;
        this.errorMessage = template.errorMessage || '';
        
        // USB configuration
        this.configuration = template.configuration || null;
        this.interface = template.interface || null;
        this.interfaceNumber = template.interfaceNumber || 0;
        this.interfaceDescriptors = template.interfaceDescriptors || [];
        this.endpoints = template.endpoints || {};
        
        // Polling state
        this.pollingActive = template.pollingActive || false;
    };

    /**
     * Creates a new ManagedUSB instance from the given WebUSB device for the
     * given client.
     *
     * @param {ManagedClient} client
     *     The client that this USB device should be associated with.
     *
     * @param {USBDevice} device
     *     The WebUSB device to use.
     *
     * @returns {ManagedUSB}
     *     The newly-created ManagedUSB.
     */
    ManagedUSB.getInstance = function getInstance(client, device) {
        return new ManagedUSB({
            client: client,
            device: device
        });
    };

    /**
     * Create flattened interface data string for Guacamole protocol.
     * Format: "iface_num:class:subclass:protocol:ep_num:dir:type:size;ep_num:dir:type:size,next_interface..."
     */
    ManagedUSB.prototype.createInterfaceData = function createInterfaceData() {
        const interfaceStrings = (this.interfaceDescriptors || []).map(iface => {
            const endpointStrings = iface.endpoints.map(ep => 
                `${ep.endpointNumber}:${ep.direction}:${ep.type}:${ep.packetSize}`
            ).join(';');
            
            return `${iface.bInterfaceNumber}:${iface.bInterfaceClass}:${iface.bInterfaceSubClass}:${iface.bInterfaceProtocol}:${endpointStrings}`;
        });
        
        return interfaceStrings.join(',');
    };

    /**
     * Collect device information including interfaces and endpoints.
     */
    ManagedUSB.prototype.collectDeviceInfo = function collectDeviceInfo() {
        const self = this;
        
        // Store active configuration
        self.configuration = self.device.configuration;
        
        if (!self.configuration?.interfaces) {
            console.warn("No configuration or interfaces available on USB device");
            return Promise.resolve();
        }
        
        self.interfaceDescriptors = [];
        self.endpoints = {};
        
        // Process each interface - claim and extract essential info
        return Promise.all(self.configuration.interfaces.map((interfaceInfo, index) => {
            return self.device.claimInterface(interfaceInfo.interfaceNumber)
                .then(() => {
                    self.claimed = true;
                    
                    // Extract essential interface information
                    const interfaceDescriptor = {
                        bInterfaceNumber: interfaceInfo.interfaceNumber,
                        bInterfaceClass: interfaceInfo.alternates[0]?.interfaceClass || 0,
                        bInterfaceSubClass: interfaceInfo.alternates[0]?.interfaceSubclass || 0,
                        bInterfaceProtocol: interfaceInfo.alternates[0]?.interfaceProtocol || 0,
                        endpoints: []
                    };
                    
                    // Extract essential endpoint information
                    interfaceInfo.alternates.forEach(alternate => {
                        alternate.endpoints.forEach(endpoint => {
                            const endpointInfo = {
                                endpointNumber: endpoint.endpointNumber,
                                direction: endpoint.direction,
                                type: endpoint.type,
                                packetSize: endpoint.packetSize,
                                interval: endpoint.interval || self.getDefaultInterval(endpoint.type)
                            };
                            
                            interfaceDescriptor.endpoints.push(endpointInfo);
                            self.endpoints[endpoint.endpointNumber] = endpointInfo;
                            
                            console.log(`Interface ${interfaceInfo.interfaceNumber}: Endpoint ${endpoint.endpointNumber} (${endpoint.direction} ${endpoint.type}, ${endpoint.packetSize} bytes)`);
                        });
                    });
                    
                    self.interfaceDescriptors.push(interfaceDescriptor);
                    
                    // Store primary interface info
                    if (index === 0) {
                        self.interface = interfaceInfo;
                        self.interfaceNumber = interfaceInfo.interfaceNumber;
                    }
                })
                .catch(error => {
                    console.warn(`Failed to claim interface ${interfaceInfo.interfaceNumber}:`, error);
                    // Continue with other interfaces even if one fails
                });
        }));
    };

    /**
     * Initiates a connection to the USB device using enhanced protocol with flattened parameters.
     *
     * @returns {Promise}
     *     A promise that resolves when the device is connected, or rejects if
     *     an error occurs.
     */
    ManagedUSB.prototype.connect = function connect() {
        const deferred = $q.defer();
        const self = this;
        
        console.log('Starting USB device connection process...');
        
        // Validate device
        if (!this.device) {
            self.errorMessage = "No USB device provided";
            console.error(self.errorMessage);
            deferred.reject(new Error(self.errorMessage));
            return deferred.promise;
        }
        
        // Open device and collect information
        this.device.open()
            .then(() => {
                console.log('USB device opened successfully');
                return self.collectDeviceInfo();
            })
            .then(() => {
                // Generate device ID if not already set
                const deviceId = self.id || self.device.serialNumber || `usb_${Date.now()}`;
                self.id = deviceId;
                
                // Create flattened interface data string
                const interfaceData = self.createInterfaceData();
                
                console.log('Sending USB connect with flattened protocol:', deviceId);
                console.log('Interface data:', interfaceData);
                
                // Send enhanced connect message with flattened parameters
                self.client.client.sendUSBConnect(
                    deviceId,
                    self.vendorId,
                    self.productId,
                    self.name,
                    self.serialNumber || '',
                    self.deviceClass,
                    self.deviceSubclass,
                    self.deviceProtocol,
                    interfaceData
                );
                
                // Mark as connected and start polling
                self.connected = true;
                self.startDevicePolling();
                
                deferred.resolve(self);
            })
            .catch(error => {
                console.error("Failed to connect USB device:", error);
                self.errorMessage = error.message || "Failed to connect USB device";
                self.connected = false;
                
                // Cleanup any partial connection
                self.cleanupLocalResources()
                    .finally(() => {
                        deferred.reject(error);
                    });
            });
        
        return deferred.promise;
    };

    /**
     * Handles data received from the remote connection.
     *
     * @param {string} deviceId
     *     The device ID this data is intended for.
     *
     * @param {number} endpoint
     *     The target endpoint number for this data.
     *
     * @param {string} data
     *     The base64-encoded data received from the remote connection.
     */
    ManagedUSB.prototype.handleRemoteData = function handleRemoteData(deviceId, endpoint, data) {
        if (!this.connected || !this.device) {
            console.warn('Ignoring remote USB data - device not connected');
            return;
        }
        
        try {
            // Verify device ID
            if (deviceId !== this.id) {
                console.warn(`USB data for wrong device: ${deviceId} vs ${this.id}`);
                return;
            }
            
            // Parse endpoint number
            const endpointNumber = parseInt(endpoint);
            
            // Decode base64 data to ArrayBuffer
            const arrayBuffer = this.base64ToArrayBuffer(data);
            
            console.log(`Received ${arrayBuffer.byteLength} bytes for endpoint ${endpointNumber}`);
            
            // Validate endpoint exists and is an OUT endpoint
            const endpointInfo = this.endpoints[endpointNumber];
            if (endpointInfo && endpointInfo.direction !== 'out') {
                console.warn(`Endpoint ${endpointNumber} is not an OUT endpoint (${endpointInfo.direction})`);
                return;
            }
            
            // Send data to the specific endpoint
            this.device.transferOut(endpointNumber, arrayBuffer)
                .then(result => {
                    console.log(`Sent ${result.bytesWritten} bytes to USB device endpoint ${endpointNumber}`);
                })
                .catch(error => {
                    console.error(`Failed to send data to USB device endpoint ${endpointNumber}:`, error);
                    this.errorMessage = `Transfer error on endpoint ${endpointNumber}: ${error.message}`;
                });
        } catch (error) {
            console.error("Failed to decode USB data from server:", error);
            this.errorMessage = "Data decode error: " + error.message;
        }
    };

    /**
     * Starts polling the USB device for incoming data.
     */
    ManagedUSB.prototype.startDevicePolling = function startDevicePolling() {
        this.pollingActive = true;
        
        const inEndpoints = Object.values(this.endpoints).filter(
            endpoint => endpoint.direction === 'in'
        );
        
        if (inEndpoints.length === 0) {
            console.warn("No IN endpoints available for USB device - polling disabled");
            return;
        }
        
        console.log(`Starting polling for ${inEndpoints.length} IN endpoints`);
        
        // Poll each IN endpoint separately
        inEndpoints.forEach(endpoint => {
            this.startPollingEndpoint(endpoint);
        });
    };

    /**
     * Start polling a specific endpoint for incoming data.
     */
    ManagedUSB.prototype.startPollingEndpoint = function startPollingEndpoint(endpoint) {
        const self = this;
        const maxPacketSize = endpoint.packetSize || 64;
        const pollingInterval = this.getPollingInterval(endpoint);
        
        function pollEndpoint() {
            if (!self.connected || !self.pollingActive) {
                return;
            }
            
            self.device.transferIn(endpoint.endpointNumber, maxPacketSize)
                .then(result => {
                    if (result.data && result.data.byteLength > 0) {
                        // Send data to remote with endpoint info
                        self.sendDataToRemote(result.data, endpoint.endpointNumber);
                    }
                    
                    // Continue polling if still connected
                    if (self.connected && self.pollingActive) {
                        setTimeout(pollEndpoint, pollingInterval);
                    }
                })
                .catch(error => {
                    // Handle transfer errors gracefully
                    if (self.connected && self.pollingActive) {
                        // Increase interval on error to avoid flooding
                        setTimeout(pollEndpoint, pollingInterval * 10);
                    }
                });
        }
        
        // Start polling after a short delay
        setTimeout(pollEndpoint, pollingInterval);
    };

    /**
     * Get appropriate polling interval based on endpoint type.
     */
    ManagedUSB.prototype.getPollingInterval = function getPollingInterval(endpoint) {
        switch(endpoint.type) {
            case 'interrupt': return 1;  // Fast polling for interrupt endpoints
            case 'bulk': return 10;      // Normal polling for bulk endpoints
            case 'isochronous': return 1; // Fast polling for isochronous
            default: return 10;
        }
    };

    /**
     * Get default interval for endpoint types.
     */
    ManagedUSB.prototype.getDefaultInterval = function getDefaultInterval(type) {
        switch (type) {
            case 'interrupt': return 1;
            case 'isochronous': return 1;
            default: return 0;
        }
    };

    /**
     * Sends data from a USB device endpoint to the remote connection using flattened parameters.
     *
     * @param {ArrayBuffer} arrayBuffer
     *     The data to send to the remote connection.
     *
     * @param {number} endpointNumber
     *     The endpoint number this data originated from.
     */
    ManagedUSB.prototype.sendDataToRemote = function sendDataToRemote(arrayBuffer, endpointNumber) {
        if (!this.connected) {
            console.warn('Cannot send USB data - not connected to server');
            return;
        }
        
        // Validate input
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            return;
        }
        
        if (endpointNumber === undefined) {
            console.error('Endpoint number is required for sending USB data');
            return;
        }
        
        try {
            // Get endpoint information
            const endpoint = this.endpoints[endpointNumber];
            
            // Convert ArrayBuffer to base64 string
            const base64Data = this.arrayBufferToBase64(arrayBuffer);
            
            // Send data using flattened protocol: deviceId, endpoint, data, length, type
            this.client.client.sendUSBData(
                this.id,
                endpointNumber,
                base64Data,
                arrayBuffer.byteLength,
                endpoint?.type || 'bulk'
            );
            
            console.log(`Sent ${arrayBuffer.byteLength} bytes from USB device endpoint ${endpointNumber} to server`);
        } catch (error) {
            console.error("Failed to send USB data to server:", error);
            this.errorMessage = "Send error: " + error.message;
        }
    };

    /**
     * Stops device polling gracefully.
     */
    ManagedUSB.prototype.stopDevicePolling = function stopDevicePolling() {
        console.log('Stopping USB device polling for device:', this.id);
        this.pollingActive = false;
    };

    /**
     * Cleans up local USB device resources without notifying the server.
     *
     * @returns {Promise}
     *     A promise that resolves when cleanup is complete.
     */
    ManagedUSB.prototype.cleanupLocalResources = function cleanupLocalResources() {
        const self = this;
        
        console.log('Cleaning up local USB resources for device:', this.id);
        
        // Stop polling first
        this.stopDevicePolling();

        // Release interface and close device
        return Promise.resolve()
            .then(() => {
                // Release interface if claimed
                if (self.claimed && self.device && self.interfaceNumber !== null) {
                    return self.device.releaseInterface(self.interfaceNumber)
                        .then(() => {
                            self.claimed = false;
                            console.log('USB interface released');
                        })
                        .catch(error => {
                            console.warn('Error releasing USB interface:', error);
                            // Continue with cleanup even if this fails
                        });
                }
            })
            .then(() => {
                // Close device
                if (self.device) {
                    return self.device.close()
                        .then(() => {
                            console.log('USB device closed');
                        })
                        .catch(error => {
                            console.warn('Error closing USB device:', error);
                            // Continue with cleanup even if this fails
                        });
                }
            })
            .then(() => {
                console.log('USB local cleanup completed for device:', self.id);
            })
            .catch(error => {
                console.error('Error during USB cleanup:', error);
                // Don't re-throw - cleanup should always succeed
            });
    };

    /**
     * Disconnects the USB device, releasing all resources.
     *
     * @returns {Promise}
     *     A promise that resolves when the device is disconnected.
     */
    ManagedUSB.prototype.disconnect = function disconnect() {
        const deferred = $q.defer();
        const self = this;
        
        console.log('Disconnecting USB device:', this.id || this.name);
        
        // Mark as disconnected first to stop polling
        this.connected = false;
        
        // Notify server of disconnection
        if (this.client && this.client.client && this.id) {
            console.log("Notifying server of USB disconnection:", this.id);
            try {
                this.client.client.sendUSBDisconnect(this.id);
            } catch (error) {
                console.warn("Error sending USB disconnect to server:", error);
            }
        }
        
        // Clean up local resources
        this.cleanupLocalResources()
            .then(() => {
                console.log('USB device disconnection completed:', self.id);
                deferred.resolve();
            })
            .catch(error => {
                console.error('Error during USB disconnection:', error);
                deferred.reject(error);
            });
        
        return deferred.promise;
    };

    /**
     * Helper to parse interface data on server side.
     * Format: "iface_num:class:subclass:protocol:ep_num:dir:type:size;ep_num:dir:type:size,next_interface..."
     */
    ManagedUSB.prototype.parseInterfaceData = function parseInterfaceData(interfaceData) {
        if (!interfaceData) return [];
        
        return interfaceData.split(',').map(ifaceStr => {
            const parts = ifaceStr.split(':');
            const interfaceNumber = parseInt(parts[0]);
            const interfaceClass = parseInt(parts[1]);
            const interfaceSubclass = parseInt(parts[2]);
            const interfaceProtocol = parseInt(parts[3]);
            
            // Parse endpoints (after the 4th colon, endpoints are separated by semicolons)
            const endpointStr = parts.slice(4).join(':');
            const endpoints = endpointStr ? endpointStr.split(';').map(epStr => {
                const epParts = epStr.split(':');
                return {
                    number: parseInt(epParts[0]),
                    direction: epParts[1],
                    type: epParts[2],
                    maxPacketSize: parseInt(epParts[3])
                };
            }) : [];
            
            return {
                number: interfaceNumber,
                class: interfaceClass,
                subclass: interfaceSubclass,
                protocol: interfaceProtocol,
                endpoints: endpoints
            };
        });
    };

    /**
     * Convert ArrayBuffer to base64 string.
     */
    ManagedUSB.prototype.arrayBufferToBase64 = function arrayBufferToBase64(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
        return btoa(binaryString);
    };

    /**
     * Convert base64 string to ArrayBuffer.
     */
    ManagedUSB.prototype.base64ToArrayBuffer = function base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    };

    return ManagedUSB;

}]);