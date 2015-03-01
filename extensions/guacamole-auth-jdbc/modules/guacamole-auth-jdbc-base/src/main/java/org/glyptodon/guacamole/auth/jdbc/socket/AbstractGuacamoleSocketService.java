/*
 * Copyright (C) 2015 Glyptodon LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

package org.glyptodon.guacamole.auth.jdbc.socket;

import com.google.inject.Inject;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import org.glyptodon.guacamole.auth.jdbc.user.AuthenticatedUser;
import org.glyptodon.guacamole.auth.jdbc.connection.ModeledConnection;
import org.glyptodon.guacamole.auth.jdbc.connectiongroup.ModeledConnectionGroup;
import org.glyptodon.guacamole.auth.jdbc.connection.ConnectionRecordMapper;
import org.glyptodon.guacamole.auth.jdbc.connection.ParameterMapper;
import org.glyptodon.guacamole.auth.jdbc.connection.ConnectionModel;
import org.glyptodon.guacamole.auth.jdbc.connection.ConnectionRecordModel;
import org.glyptodon.guacamole.auth.jdbc.connection.ParameterModel;
import org.glyptodon.guacamole.auth.jdbc.user.UserModel;
import org.glyptodon.guacamole.GuacamoleException;
import org.glyptodon.guacamole.environment.Environment;
import org.glyptodon.guacamole.net.GuacamoleSocket;
import org.glyptodon.guacamole.net.InetGuacamoleSocket;
import org.glyptodon.guacamole.net.auth.Connection;
import org.glyptodon.guacamole.net.auth.ConnectionGroup;
import org.glyptodon.guacamole.net.auth.ConnectionRecord;
import org.glyptodon.guacamole.protocol.ConfiguredGuacamoleSocket;
import org.glyptodon.guacamole.protocol.GuacamoleClientInformation;
import org.glyptodon.guacamole.protocol.GuacamoleConfiguration;
import org.glyptodon.guacamole.token.StandardTokens;
import org.glyptodon.guacamole.token.TokenFilter;


/**
 * Base implementation of the GuacamoleSocketService, handling retrieval of
 * connection parameters, load balancing, and connection usage counts. The
 * implementation of concurrency rules is up to policy-specific subclasses.
 *
 * @author Michael Jumper
 */
public abstract class AbstractGuacamoleSocketService implements GuacamoleSocketService {

    /**
     * The environment of the Guacamole server.
     */
    @Inject
    private Environment environment;
 
    /**
     * Mapper for accessing connection parameters.
     */
    @Inject
    private ParameterMapper parameterMapper;

    /**
     * Mapper for accessing connection history.
     */
    @Inject
    private ConnectionRecordMapper connectionRecordMapper;

    /**
     * The current number of concurrent uses of the connection having a given
     * identifier.
     */
    private final Map<String, LinkedList<ConnectionRecord>> activeConnections =
            new HashMap<String, LinkedList<ConnectionRecord>>();

    /**
     * Atomically increments the current usage count for the given connection.
     *
     * @param connection
     *     The connection which is being used.
     */
    private void addActiveConnection(Connection connection, ConnectionRecord record) {
        synchronized (activeConnections) {

            String identifier = connection.getIdentifier();

            // Get set of active connection records, creating if necessary
            LinkedList<ConnectionRecord> connections = activeConnections.get(identifier);
            if (connections == null) {
                connections = new LinkedList<ConnectionRecord>();
                activeConnections.put(identifier, connections);
            }

            // Add active connection
            connections.addFirst(record);

        }
    }

    /**
     * Atomically decrements the current usage count for the given connection.
     * If a combination of incrementUsage() and decrementUsage() calls result
     * in the usage counter being reduced to zero, it is guaranteed that one
     * of those decrementUsage() calls will remove the value from the map.
     *
     * @param connection
     *     The connection which is no longer being used.
     */
    private void removeActiveConnection(Connection connection, ConnectionRecord record) {
        synchronized (activeConnections) {

            String identifier = connection.getIdentifier();

            // Get set of active connection records
            LinkedList<ConnectionRecord> connections = activeConnections.get(identifier);
            assert(connections != null);

            // Remove old record
            connections.remove(record);

            // If now empty, clean the tracking entry
            if (connections.isEmpty())
                activeConnections.remove(identifier);

        }
    }

    /**
     * Acquires possibly-exclusive access to the given connection on behalf of
     * the given user. If access is denied for any reason, an exception is
     * thrown.
     *
     * @param user
     *     The user acquiring access.
     *
     * @param connection
     *     The connection being accessed.
     *
     * @throws GuacamoleException
     *     If access is denied to the given user for any reason.
     */
    protected abstract void acquire(AuthenticatedUser user,
            ModeledConnection connection) throws GuacamoleException;

    /**
     * Releases possibly-exclusive access to the given connection on behalf of
     * the given user. If the given user did not already have access, the
     * behavior of this function is undefined.
     *
     * @param user
     *     The user releasing access.
     *
     * @param connection
     *     The connection being released.
     */
    protected abstract void release(AuthenticatedUser user,
            ModeledConnection connection);

    @Override
    public GuacamoleSocket getGuacamoleSocket(final AuthenticatedUser user,
            final ModeledConnection connection, GuacamoleClientInformation info)
            throws GuacamoleException {

        // Create record for active connection
        final ActiveConnectionRecord activeConnection = new ActiveConnectionRecord(user);
        
        // Generate configuration from available data
        GuacamoleConfiguration config = new GuacamoleConfiguration();

        // Set protocol from connection
        ConnectionModel model = connection.getModel();
        config.setProtocol(model.getProtocol());

        // Set parameters from associated data
        Collection<ParameterModel> parameters = parameterMapper.select(connection.getIdentifier());
        for (ParameterModel parameter : parameters)
            config.setParameter(parameter.getName(), parameter.getValue());

        // Build token filter containing credential tokens
        TokenFilter tokenFilter = new TokenFilter();
        StandardTokens.addStandardTokens(tokenFilter, user.getCredentials());

        // Filter the configuration
        tokenFilter.filterValues(config.getParameters());

        // Return new socket
        try {

            // Atomically gain access to connection
            acquire(user, connection);
            addActiveConnection(connection, activeConnection);

            // Return newly-reserved connection
            return new ConfiguredGuacamoleSocket(
                new InetGuacamoleSocket(
                    environment.getRequiredProperty(Environment.GUACD_HOSTNAME),
                    environment.getRequiredProperty(Environment.GUACD_PORT)
                ),
                config
            ) {

                @Override
                public void close() throws GuacamoleException {

                    // Attempt to close connection
                    super.close();
                    
                    // Release connection upon close
                    removeActiveConnection(connection, activeConnection);
                    release(user, connection);

                    UserModel userModel = user.getUser().getModel();
                    ConnectionRecordModel recordModel = new ConnectionRecordModel();

                    // Copy user information and timestamps into new record
                    recordModel.setUserID(userModel.getObjectID());
                    recordModel.setUsername(userModel.getIdentifier());
                    recordModel.setConnectionIdentifier(connection.getIdentifier());
                    recordModel.setStartDate(activeConnection.getStartDate());
                    recordModel.setEndDate(new Date());

                    // Insert connection record
                    connectionRecordMapper.insert(recordModel);
                    
                }
                
            };

        }

        // Release connection in case of error
        catch (GuacamoleException e) {

            // Atomically release access to connection
            removeActiveConnection(connection, activeConnection);
            release(user, connection);

            throw e;

        }

    }

    @Override
    public List<ConnectionRecord> getActiveConnections(Connection connection) {
        synchronized (activeConnections) {

            String identifier = connection.getIdentifier();

            // Get set of active connection records
            LinkedList<ConnectionRecord> connections = activeConnections.get(identifier);
            if (connections != null)
                return Collections.unmodifiableList(connections);

            return Collections.EMPTY_LIST;

        }
    }

    @Override
    public GuacamoleSocket getGuacamoleSocket(AuthenticatedUser user,
            ModeledConnectionGroup connectionGroup,
            GuacamoleClientInformation info) throws GuacamoleException {
        // STUB
        throw new UnsupportedOperationException("STUB");
    }

    @Override
    public List<ConnectionRecord> getActiveConnections(ConnectionGroup connectionGroup) {
        // STUB
        return Collections.EMPTY_LIST;
    }
    
}