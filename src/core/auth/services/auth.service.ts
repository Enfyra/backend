// External packages
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';

// @nestjs packages
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

// Internal imports
import { QueryBuilderService } from '../../../infrastructure/query-builder/query-builder.service';

// Relative imports
import { LoginAuthDto } from '../dto/login-auth.dto';
import { LogoutAuthDto } from '../dto/logout-auth.dto';
import { RefreshTokenAuthDto } from '../dto/refresh-token-auth.dto';
import { BcryptService } from './bcrypt.service';

@Injectable()
export class AuthService {
  constructor(
    private bcryptService: BcryptService,
    private configService: ConfigService,
    private jwtService: JwtService,
    private queryBuilder: QueryBuilderService,
  ) {}

  async login(body: LoginAuthDto) {
    const { email, password } = body;

    // Find user by email
    const user = await this.queryBuilder.findOneWhere('user_definition', { email });

    if (!user || !user.password) {
      throw new BadRequestException(`Login failed!`);
    }

    // Test: create a new hash from the input password to verify bcrypt is working
    const testHash = await this.bcryptService.hash(password);
    const testCompare = await this.bcryptService.compare(password, testHash);
    console.log('🔐 Test hash/compare (should be true):', testCompare);

    const isMatch = await this.bcryptService.compare(password, user.password);
    console.log('🔐 Compare result:', isMatch);

    if (!isMatch) {
      throw new BadRequestException(`Login failed!`);
    }

    // Create session
    const isMongoDB = this.queryBuilder.isMongoDb();
    const userId = isMongoDB 
      ? (typeof user._id === 'string' ? new ObjectId(user._id) : user._id)
      : (user.id || user._id);
    
    const sessionData: any = isMongoDB 
      ? {
          user: userId, // MongoDB: ObjectId
          expiredAt: new Date(), // MongoDB doesn't auto-set defaultValue
          remember: body.remember || false,
        }
      : {
          id: randomUUID(), // SQL: UUID for primary key
          userId: userId.toString(), // SQL: convert to string for varchar(36)
          remember: body.remember,
        };

    console.log('🔍 DEBUG SESSION INSERT:', { 
      sessionData, 
      dbType: this.queryBuilder.getDatabaseType(),
      isMongoDB: this.queryBuilder.isMongoDb()
    });
    const insertedSession = await this.queryBuilder.insertAndGet('session_definition', sessionData);
    console.log('🔍 DEBUG SESSION RESULT:', insertedSession);
      
    // Get session ID (MongoDB uses _id, SQL uses id)
    const sessionId = isMongoDB 
      ? (insertedSession._id?.toString() || insertedSession.id)
      : (insertedSession.id || sessionData.id);

    const accessToken = this.jwtService.sign(
      {
        id: isMongoDB ? user._id : user.id,
      },
      {
        expiresIn: this.configService.get<string>('ACCESS_TOKEN_EXP'),
      },
    );
    const refreshToken = this.jwtService.sign(
      {
        sessionId: sessionId,
      },
      {
        expiresIn: body.remember
          ? this.configService.get<string>('REFRESH_TOKEN_REMEMBER_EXP')
          : this.configService.get<string>('REFRESH_TOKEN_NO_REMEMBER_EXP'),
      },
    );
    const decoded: any = this.jwtService.decode(accessToken);
    return {
      accessToken,
      refreshToken,
      expTime: decoded.exp * 1000,
    };
  }

  async logout(body: LogoutAuthDto, req: Request & { user: any }) {
    let decoded: any;
    try {
      decoded = this.jwtService.verify(body.refreshToken);
    } catch (e) {
      throw new BadRequestException('Invalid or expired refresh token!');
    }
    
    const { sessionId } = decoded;
    
    // Find session with user (normalize id vs _id for MongoDB)
    const sessionIdField = this.queryBuilder.isMongoDb() ? '_id' : 'id';
    const session = await this.queryBuilder.findOneWhere('session_definition', { [sessionIdField]: sessionId });

    const userIdToCheck = this.queryBuilder.isMongoDb() ? req.user._id : req.user.id;
    const sessionUserId = this.queryBuilder.isMongoDb() ? (session?.user?._id || session?.user) : session?.userId;
    
    if (!session || String(sessionUserId) !== String(userIdToCheck)) {
      throw new BadRequestException(`Logout failed!`);
    }

    await this.queryBuilder.deleteById('session_definition', session._id || session.id);
    return 'Logout successfully!';
  }

  async refreshToken(body: RefreshTokenAuthDto) {
    let decoded: any;
    try {
      decoded = this.jwtService.verify(body.refreshToken);
    } catch (e) {
      throw new BadRequestException('Invalid or expired refresh token!');
    }
    
    // Find session (normalize id vs _id for MongoDB)
    const sessionIdField = this.queryBuilder.isMongoDb() ? '_id' : 'id';
    const session = await this.queryBuilder.findOneWhere('session_definition', { 
      [sessionIdField]: decoded.sessionId 
    });

    if (!session) {
      throw new BadRequestException('Session not found!');
    }

    const accessToken = this.jwtService.sign(
      {
        id: session.userId,
      },
      {
        expiresIn: this.configService.get<string>('ACCESS_TOKEN_EXP'),
      },
    );
    
    // Get session ID for new refresh token (MongoDB uses _id, SQL uses id)
    const sessionIdForRefresh = this.queryBuilder.isMongoDb() 
      ? (session._id?.toString() || session._id)
      : session.id;
    
    const refreshToken = session.remember
      ? this.jwtService.sign(
          { sessionId: sessionIdForRefresh },
          {
            expiresIn: this.configService.get<string>(
              'REFRESH_TOKEN_REMEMBER_EXP',
            ),
          },
        )
      : body.refreshToken;
    const accessTokenDecoded = await this.jwtService.decode(accessToken);
    return {
      accessToken,
      refreshToken,
      expTime: accessTokenDecoded.exp * 1000,
    };
  }
}
